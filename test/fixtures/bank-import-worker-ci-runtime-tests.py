"""Native upgrade spine with real files/hashes and deterministic systemd/proc/native-command ports. Hosted only."""
import contextlib
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

def encoded(value):return json.dumps(value,sort_keys=True,separators=(',',':')).encode()+b'\n'

class Fixture(old.UpgradeFlowFixture):
    def __init__(self,root):
        super().__init__(root)
        self.invoke('drain');os.utime(self.operation/'drained.json',(1794873602,1794873602));self.web=self.source;self.native_calls=0;self.finish_at=None;self.fault_at=None;self.native_fault=None;self.held_phase='installing';self.arrive_at=None;self.cleanup_at=None;self.cleanup_failures=0;self.cleanup_persistent=False;self.lease_backslide_at=None;self.probe_override=None
        self.webroot=root/'web';self.webroot.mkdir();(self.webroot/'.next').mkdir();(self.webroot/'.next/BUILD_ID').write_text(self.new_build)
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
        self.grant.update(policyVersion='aihr-staging-ci/v17',controllerBranch='alpha',runAttempt=1,runCreatedAt='2026-11-17T00:00:00Z',issuedAt='2026-11-17T00:00:00Z',expiresAt='2026-11-17T00:20:00Z',producerStartedAt='2026-11-17T00:00:00Z',producerCompletedAt='2026-11-17T00:00:00Z',witnessFingerprint='9'*64,artifact={'digest':'sha256:'+'8'*64,'id':1})
        self.grant['build'].update(format=2,capacityProfile={},buildSourcePath='/frozen',runtime={},provenanceSha256='1'*64,archiveSha256='2'*64,archiveBytes=1,manifestSha256='3'*64,preparedSha256='4'*64,successfulObservationSha256='5'*64)
        self.activated={'activation':{'activeDirectory':{'device':1,'inode':11},'retainedDirectory':{'device':1,'inode':12}},'kind':'CI_BUILD_BYTES_ACTIVATED_NOT_FULL_ARRIVAL','source':self.source,'installId':self.install_id,'buildRecordId':self.build_record,'nextBuildId':self.new_build,'bootIdSha256':ci.sha(self.boot.read_bytes())}
        self.ledger={'format':1,'kind':'READ_ONLY_EXACT_MIGRATION_LEDGER_NOT_RELEASE','rows':919,'expectedSha256':'d'*64,'actualSha256':'e'*64,'releaseAuthorized':False}
        self.runtime={'kind':'CI_BUILD_ACTIVE_SERVICE_VERIFIED_NOT_FULL_ARRIVAL','format':1,'source':self.source,'installId':self.install_id,'buildRecordId':self.build_record,'nextBuildId':self.new_build,'authorizationSha256':ci.sha(encoded(self.grant)),'pid':'999','startedMonotonicUs':2000000,'healthStatus':200,'fullMigrationLedgerVerified':True,'fullSourceChecksumVerified':False,'releaseAuthorized':False,'migrationLedger':{**self.ledger,'verifiedAt':'2026-11-17T00:00:00.000Z'},'compiledByteInventory':{'format':2,'files':12000},'verifiedAt':'2026-11-17T00:00:00.000Z'}
        for name,value in [('authorization.json',self.grant),('activated.json',self.activated),('runtime.json',self.runtime)]:
            (self.directory/name).write_bytes(encoded(value));(self.directory/name).chmod(0o600)
        self.lease={'protocol':'aihr-staging-queue/v1','batch':'32345678-1234-4123-8123-123456789abc','epoch':4,'candidate':self.source,'token':'f'*64,'releaseAuthorized':False}
        self.leasefile=root/'lease.json';self.leasefile.write_bytes(encoded(self.lease));self.leasefile.chmod(0o600)
        filters=ci.canonical_filters(self.base,self.webroot)
        manifest={'format':1,'kind':'CANONICAL_FROZEN_SOURCE_CONTENT_INVENTORY','policy':ci.POLICY,'source':self.source,'filters':filters,'entries':ci.source_inventory(self.base,self.webroot,filters),'releaseSha256':ci.sha((self.webroot/'scripts/improve/release.ts').read_bytes()),'filterOwnerSha256':ci.sha((self.webroot/'.github/ci/normal-cleanup-fences.mjs').read_bytes())}
        self.source_manifest_file=root/'source-manifest.json';self.source_manifest_file.write_bytes(encoded(manifest))
        self.helper=root/'protected-bundle.py';self.helper.write_text('independently reviewed root bundle fixture')
        self.authorization=root/'activation-authorization.json'
        drain=(self.operation/'drained.json').read_bytes();st=self.directory.stat()
        self.auth={'format':1,'kind':'ADMIN_AUTHORIZED_SINGLE_CI_WORKER_CUTOVER','policy':ci.POLICY,'target':'alpha-staging','issuedAt':'2026-11-17T00:00:05Z','expiresAt':'2026-11-17T00:10:00Z','identity':json.loads(drain)['identity'],'drainSha256':ci.sha(drain),'helperSha256':ci.sha(self.helper.read_bytes()),'nodeSha256':ci.sha(self.node.read_bytes()),'install':{'id':self.install_id,'buildRecordId':self.build_record,'runId':77,'controller':'3'*40,'directory':str(self.directory),'uid':uid,'gid':self.owner.pw_gid,'device':st.st_dev,'inode':st.st_ino},'grantSha256':ci.sha(encoded(self.grant)),'activatedSha256':ci.sha(encoded(self.activated)),'runtimeSha256':ci.sha(encoded(self.runtime)),'environmentSha256':'c'*64,'dotenvSha256':ci.sha((self.webroot/'.env.production').read_bytes()),'ledger':self.ledger,'bootIdSha256':ci.sha(self.boot.read_bytes()),'webPid':'999','webStartedMonotonicUs':2000000,'lease':{k:self.lease[k]for k in ['batch','epoch','candidate']},'leaseFile':str(self.leasefile),'leaseFileSha256':ci.sha(self.leasefile.read_bytes()),'coordinatorSha256':ci.sha(self.coordinator.read_bytes()),'sourceManifest':str(self.source_manifest_file),'sourceManifestSha256':ci.sha(self.source_manifest_file.read_bytes()),'priorLastOkSha256':ci.sha((self.state/'last-ok').read_bytes()),'launch':{'current':{k:v for k,v in self.current.items()if k not in ['result','exit_code','finished_at']},'processStartTicks':'444','cmdlineSha256':ci.sha(p.joinpath('cmdline').read_bytes())},'releaseAuthorized':False,'readiness':{'required':'1','waitSeconds':None}}
        self.firstfile=root/'original-pre-drain-approval.json'
        self.first={'format':1,'kind':'ADMIN_REVIEWED_CI_WORKER_DRAIN_PINS','policy':ci.POLICY,'target':'alpha-staging','issuedAt':'2026-11-17T00:00:00Z','expiresAt':'2026-11-17T00:00:04Z',**{k:self.auth[k]for k in ['identity','helperSha256','nodeSha256','lease','leaseFileSha256','sourceManifestSha256','environmentSha256','dotenvSha256','readiness']},'gate':{k:self.grant[k]for k in ['source','controller','runId','build','artifact','witnessFingerprint','policyVersion']},'releaseAuthorized':False}
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
        self.finish();self.held_phase='arrived'
        audit=self.directory/'audit';audit.mkdir(mode=0o700);(audit/'bytes').mkdir(mode=0o700)
        # Same real ordering as retainNormalCleanupAudit -> durable marker -> packet/retained removal.
        (audit/'source-contract-retained').write_text('original frozen source/provenance audit bytes')
        c={'format':1,'kind':'OWNED_CI_INSTALL_CLEANUP_AFTER_VERIFIED_ARRIVAL','sourceDirectory':str(self.webroot),'source':self.source,'installId':self.install_id,'buildRecordId':self.build_record,'nextBuildId':self.new_build,'authorizationSha256':self.auth['grantSha256'],'witnessFingerprint':self.grant['witnessFingerprint'],'directory':self.store['directory'],'activeDirectory':self.activated['activation']['activeDirectory'],'retainedDirectory':self.activated['activation']['retainedDirectory'],'packetDirectory':self.store['packetDirectory'],'sourceProof':{'format':1,'kind':'OPERATOR_OBSERVED_SOURCE_CHECKSUM_FOR_OWNED_CLEANUP','source':self.source,'installId':self.install_id,'buildRecordId':self.build_record,'nextBuildId':self.new_build,'authorizationSha256':self.auth['grantSha256'],'witnessFingerprint':self.grant['witnessFingerprint'],'outputSha256':ci.sha(b''),'checkedAt':'2026-11-17T00:00:08.999Z'},'sourceProofSha256':'recomputed below','authorizedAt':'2026-11-17T00:00:09.000Z'}
        c['sourceProofSha256']=ci.sha(ci.canonical(c['sourceProof']))
        (self.directory/'cleanup-authorized.json').write_bytes(encoded(c));(self.directory/'cleanup-authorized.json').chmod(0o600)
        shutil.rmtree(self.directory/'packet');self.cleanup_failures=1
    def native(self,argv,identity,environment,**options):
        check(identity.pw_uid==self.owner.pw_uid and identity.pw_uid>0,'native command did not drop root')
        check(environment['HOME']==str(self.home) and environment['AIHR_STAGING_TOKEN']==self.lease['token'],'native controlled identity/lease environment differs')
        if argv[0]=='/usr/bin/python3':return {'releaseAuthorized':False,**self.auth['lease'],'phase':self.held_phase}
        if '-e' in argv:
            check(argv==[str(self.node),'--env-file=.env.production','-e',ci.READINESS_PROBE],'fixed native readiness probe changed')
            env=dict(line.split('=',1)for line in (self.webroot/'.env.production').read_text().splitlines())
            return {'kind':'CI_WORKER_READINESS_POLICY_V1',**(self.probe_override or {'required':env.get('AIHR_IMPORT_WORKER_REQUIRED'),'waitSeconds':env.get('AIHR_IMPORT_WORKER_WAIT_SECONDS')})}
        check(argv==[str(self.node),'--env-file=.env.production','--import','tsx','.github/ci/staging-build-install.mjs','status',self.source,self.install_id,self.build_record],'native status selection/argv differs')
        self.native_calls+=1
        if self.finish_at==self.native_calls:self.finish()
        if self.arrive_at==self.native_calls:self.finish();self.held_phase='arrived'
        if self.lease_backslide_at==self.native_calls:self.held_phase='installing'
        if self.cleanup_at==self.native_calls:self.begin_cleanup()
        marker=self.directory/'cleanup-authorized.json'
        if marker.exists() and json.loads(marker.read_bytes()).get('kind')!='OWNED_CI_INSTALL_CLEANUP_AFTER_VERIFIED_ARRIVAL':raise ValueError('native cleanup authority invalid')
        if self.cleanup_failures or (self.cleanup_persistent and marker.exists()):
            self.cleanup_failures=max(0,self.cleanup_failures-1);raise ValueError('native sourceContract selected packet before normal cleanup removed it')
        if self.fault_at==self.native_calls:
            if self.native_fault=='failed':self.current['result']='failed';self.write_records()
            elif self.native_fault=='source':(self.webroot/'source-000').write_text('drift after launch')
            elif self.native_fault=='lease-inode':
                p=self.root/'replacement-lease';p.write_bytes(self.leasefile.read_bytes());p.chmod(0o600);os.replace(p,self.leasefile)
            elif self.native_fault=='backslide':self.current.update(result='',exit_code='');self.current.pop('finished_at',None);self.prior={'ref':self.previous_web,'pid':'666','log':'/private/previous-deploy.log','started_at':'2026-11-16T00:00:00Z','phase':'restart','result':'','exit_code':'0','build_id':self.old_build,'built_at':'2026-11-16T00:01:00Z','finished_at':'2026-11-16T00:02:00Z'};self.write_records()
        result={'authorizationSha256':self.auth['grantSha256'],'releaseAuthorized':False,'runtime':copy.deepcopy(self.runtime),'verified':{},'activated':copy.deepcopy(self.activated)}
        result['runtime']['migrationLedger']['verifiedAt']='2026-11-17T00:00:%02d.000Z'%self.native_calls
        result['runtime']['verifiedAt']='2026-11-17T00:00:%02d.001Z'%self.native_calls
        if self.native_fault in ['ledger-extra','ledger-missing','ledger-time','runtime-time','ledger-time-order']:
            ledger=result['runtime']['migrationLedger']
            if self.native_fault=='ledger-extra':ledger['unknown']=True
            if self.native_fault=='ledger-missing':ledger.pop('verifiedAt')
            if self.native_fault=='ledger-time':ledger['verifiedAt']='not-a-time'
            if self.native_fault=='runtime-time':result['runtime']['verifiedAt']='not-a-time'
            if self.native_fault=='ledger-time-order':ledger['verifiedAt']='2026-11-17T00:00:59.000Z'
        if self.native_fault in ['pid','ledger','compiled','wrong-install','environment-proof']:
            if self.native_fault=='pid':result['runtime']['pid']='1000'
            if self.native_fault=='ledger':result['runtime']['migrationLedger']['actualSha256']='0'*64
            if self.native_fault=='compiled':result['runtime']['compiledByteInventory']['format']=1
            if self.native_fault=='wrong-install':result['runtime']['installId']='different'
            if self.native_fault=='environment-proof':raise ValueError('native full environment proof differs')
        return result
    @contextlib.contextmanager
    def ports(self):
        original_fstat=os.fstat
        with ExitStack() as s:
            for name,value in [('SOURCE',self.webroot),('STATE',self.state),('COORDINATOR',self.coordinator),('BOOT_ID',self.boot),('PROCESS_ROOT',self.proc)]:s.enter_context(patch.object(ci,name,value))
            s.enter_context(patch.object(ci,'child',side_effect=self.native));s.enter_context(patch.object(ci.pwd,'getpwuid',return_value=self.owner))
            s.enter_context(patch.object(ci.time,'time',return_value=1794873610));s.enter_context(patch.object(update.time,'sleep'))
            s.enter_context(patch.object(sys,'argv',[str(self.helper)]))
            s.enter_context(patch.object(update.os,'geteuid',return_value=0))
            s.enter_context(patch.object(update.os,'fstat',side_effect=lambda fd:SimpleNamespace(st_mode=original_fstat(fd).st_mode,st_uid=0,st_nlink=1,st_dev=original_fstat(fd).st_dev,st_ino=original_fstat(fd).st_ino)))
            s.enter_context(patch.object(update,'properties',side_effect=lambda _:dict(self.report)))
            s.enter_context(patch.object(update,'HTTPConnection',side_effect=self.health_connection))
            s.enter_context(patch.object(update,'validate_process',side_effect=lambda _,report,source:int(report['MainPID'])))
            yield
    def conditional(self):
        args=self.args('activate-ci-runtime',{'ci-runtime-authorization':str(self.authorization),'ci-runtime-authorization-sha256':ci.sha(self.authorization.read_bytes())})
        with self.ports(),contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):update.upgrade(args,self.fmt,self.base,ci)

class ConditionalRuntimeTests(unittest.TestCase):
    def test_running_ci_retains_old_last_ok_and_honest_partial_receipt(self):
        with tempfile.TemporaryDirectory()as tmp:
            f=Fixture(Path(tmp));old_last=(f.state/'last-ok').read_bytes();environment=f.env.read_bytes();dotenv=(f.webroot/'.env.production').read_bytes();f.conditional()
            r=json.loads((f.operation/'activated.json').read_text());self.assertEqual(r['mode'],'activate-ci-runtime');self.assertFalse(r['journeyVerified']);self.assertEqual(set(r['transitionStages']),{'R0'});self.assertEqual((f.state/'last-ok').read_bytes(),old_last);self.assertEqual(f.env.read_bytes(),environment);self.assertEqual((f.webroot/'.env.production').read_bytes(),dotenv)
    def test_normal_finish_can_complete_at_every_prestart_and_three_four_second_observation(self):
        for call in range(1,10):
            with self.subTest(native_call=call),tempfile.TemporaryDirectory()as tmp:
                f=Fixture(Path(tmp));f.finish_at=call;f.conditional();r=json.loads((f.operation/'activated.json').read_text());self.assertEqual(r['transitionStages'][-1],'O');self.assertFalse(r['journeyVerified']);self.assertEqual(f.current['result'],'ok')
    def test_coherent_native_r1_publication_then_ok_is_monotonic(self):
        with tempfile.TemporaryDirectory()as tmp:
            f=Fixture(Path(tmp));f.finish('R1');f.finish_at=2;f.conditional();r=json.loads((f.operation/'activated.json').read_text());self.assertEqual(r['transitionStages'][0],'R1');self.assertEqual(r['transitionStages'][-1],'O')
    def test_initial_strict_ok_is_admitted_only_under_same_pins(self):
        with tempfile.TemporaryDirectory()as tmp:
            f=Fixture(Path(tmp));f.finish();f.conditional();self.assertEqual(set(json.loads((f.operation/'activated.json').read_text())['transitionStages']),{'O'})
    def test_same_lease_arrives_and_normal_cleanup_crosses_every_native_boundary(self):
        for boundary in range(1,10):
            for cleanup in [False,True]:
                with self.subTest(boundary=boundary,cleanup=cleanup),tempfile.TemporaryDirectory()as tmp:
                    f=Fixture(Path(tmp))
                    if cleanup:f.cleanup_at=boundary
                    else:f.arrive_at=boundary
                    f.conditional();r=json.loads((f.operation/'activated.json').read_text());self.assertEqual(r['transitionStages'][-1],'O');self.assertEqual(r['leasePhases'][-1],'arrived');self.assertFalse(r['journeyVerified'])
                    if cleanup:self.assertTrue(list(f.operation.glob('ci-runtime-native-retry-*.json')));self.assertFalse((f.directory/'packet').exists())
    def test_arrived_requires_strict_ok_and_lease_never_backslides(self):
        for stage in ['R0','R1','wrong-build']:
            with self.subTest(stage=stage),tempfile.TemporaryDirectory()as tmp:
                f=Fixture(Path(tmp));f.held_phase='arrived'
                if stage=='R1':f.finish('R1')
                if stage=='wrong-build':f.finish();(f.webroot/'.next/BUILD_ID').write_text('other-build')
                with self.assertRaises(ValueError):f.conditional()
                self.assertFalse((f.app/'releases'/f.source).exists())
        with tempfile.TemporaryDirectory()as tmp:
            f=Fixture(Path(tmp));f.arrive_at=1;f.lease_backslide_at=6
            with self.assertRaises(RuntimeError):f.conditional()
            self.assertFalse((f.operation/'activated.json').exists());self.assertEqual(f.report['Restart'],'no')
    def test_persistent_normal_cleanup_failure_requires_quarantine_not_a_waiver(self):
        with tempfile.TemporaryDirectory()as tmp:
            f=Fixture(Path(tmp));f.cleanup_at=6;f.cleanup_persistent=True
            with self.assertRaises(RuntimeError):f.conditional()
            self.assertEqual(f.native_calls,8);self.assertFalse((f.operation/'activated.json').exists());self.assertEqual(f.report['Restart'],'no')
    def test_wrong_expired_missing_and_late_grant_or_authority_refuse_before_package_or_unit_mutation(self):
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
                if defect in ['unknown-grant','unknown-build','cleaned-install','unknown-current','unknown-last-ok','filter-drift','wrong-first-gate','wrong-first-artifact','wrong-first-helper','postdated-first-approval','expired-at-drain','world-readable-first-approval','first-web-env','first-dotenv','first-readiness','bad-readiness']:
                    target=f.grant if defect=='unknown-grant' else f.grant['build'];target['extra']=True;(f.directory/'authorization.json').write_bytes(encoded(f.grant));f.auth['grantSha256']=ci.sha(encoded(f.grant))
                if defect=='cleaned-install':(f.directory/'cleanup-authorized.json').write_text('{}')
                if defect=='unknown-current':f.current['unapproved']='extra';f.auth['launch']['current']['unapproved']='extra';f.write_records()
                if defect=='unknown-last-ok':f.prior['unapproved']='extra';f.write_records()
                if defect=='filter-drift':
                    m=json.loads(f.source_manifest_file.read_text());m['filters'].append('source-000');m['entries']=[row for row in m['entries']if row['path']!='source-000'];f.source_manifest_file.write_bytes(encoded(m));f.auth['sourceManifestSha256']=ci.sha(f.source_manifest_file.read_bytes())
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
                self.assertEqual(f.unit.read_bytes(),before);self.assertFalse((f.app/'releases'/f.source).exists());self.assertFalse((f.operation/'activated.json').exists())
    def test_fresh_native_proof_refuses_pid_ledger_compiled_install_and_full_environment_drift(self):
        for defect in ['pid','ledger','compiled','wrong-install','environment-proof','ledger-extra','ledger-missing','ledger-time','runtime-time','ledger-time-order']:
            with self.subTest(defect=defect),tempfile.TemporaryDirectory()as tmp:
                f=Fixture(Path(tmp));f.native_fault=defect
                with self.assertRaises(ValueError):f.conditional()
                self.assertFalse((f.app/'releases'/f.source).exists());self.assertFalse((f.operation/'activated.json').exists())
    def test_deploy_failure_or_source_drift_after_worker_start_uses_existing_quarantine(self):
        for defect in ['failed','source','backslide']:
            with self.subTest(defect=defect),tempfile.TemporaryDirectory()as tmp:
                f=Fixture(Path(tmp));f.fault_at=6;f.native_fault=defect
                if defect=='backslide':f.finish_at=1
                with self.assertRaisesRegex(RuntimeError,'retained packages|Retained packages'):f.conditional()
                self.assertTrue((f.operation/'activation-failure-observation.json').exists());self.assertFalse((f.operation/'activated.json').exists());self.assertEqual(f.report['Restart'],'no');self.assertEqual(f.report['SendSIGKILL'],'no');self.assertEqual(f.report['UnitFileState'],'disabled')
    def test_conditional_authority_cannot_be_reused_or_passed_to_normal_modes(self):
        with tempfile.TemporaryDirectory()as tmp:
            f=Fixture(Path(tmp));f.conditional()
            with self.assertRaises(ValueError):f.conditional()
            with self.assertRaisesRegex(ValueError,'belong only'):
                with f.ports():update.upgrade(f.args('activate',{'ci-runtime-authorization':str(f.authorization),'ci-runtime-authorization-sha256':ci.sha(f.authorization.read_bytes())}),f.fmt,f.base,ci)
    def test_changed_lease_inode_is_refused_before_unit_replacement(self):
        with tempfile.TemporaryDirectory()as tmp:
            f=Fixture(Path(tmp));f.fault_at=1;f.native_fault='lease-inode';before=f.unit.read_bytes()
            with self.assertRaisesRegex(ValueError,'credential identity'):f.conditional()
            self.assertEqual(f.unit.read_bytes(),before);self.assertFalse((f.app/'releases'/f.source).exists())
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
    def test_native_command_drops_uid_gid_groups_and_has_no_shell_or_inherited_loader(self):
        owner=SimpleNamespace(pw_uid=1001,pw_gid=1001);env={'HOME':'/private/owner','PATH':'/opt/node22/bin:/usr/bin:/bin'}
        with patch.object(ci,'bounded_process',return_value=b'{}')as run:
            self.assertEqual(ci.child(['/opt/node22/bin/node','fixed-status'],owner,env),{})
            kwargs=run.call_args.kwargs;self.assertEqual(kwargs['user'],1001);self.assertEqual(kwargs['group'],1001);self.assertEqual(kwargs['extra_groups'],[]);self.assertEqual(kwargs['env'],env);self.assertNotIn('shell',kwargs)

if __name__=='__main__':unittest.main()
