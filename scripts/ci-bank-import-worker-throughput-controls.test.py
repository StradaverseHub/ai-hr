"""Pure consumer refusal controls, executed only by the future GitHub Linux workflow.
No application import, native process, database, network or release authority.
"""
import copy
from contextlib import contextmanager
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch
import warnings
import zipfile

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('throughput_controls_subject',HERE/'bank_import_worker_throughput_proof.py')
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)

@contextmanager
def lifecycle_fixture():
    # Fake cgroup directories only. No cgroup mount, child process, signal or DB.
    with tempfile.TemporaryDirectory(prefix='throughput-lifecycle-controls-') as temporary:
        parent=Path(temporary)/'namespace';parent.mkdir();info=parent.stat();snapshots=[]
        registry=object.__new__(p.Registry)
        registry.root=Path(temporary)
        registry.data={'format':1,'runId':1,'controller':'a'*40,'children':[],'forcedCleanup':False,'createdChildren':0,'finishedChildren':0,'resources':[],'namespace':{'dev':info.st_dev,'ino':info.st_ino,'state':'present'}}
        registry.gate=Path(temporary)/'gate.py'
        registry.save=lambda:snapshots.append(copy.deepcopy(registry.data))
        with patch.object(p,'cgroup_root',return_value=parent),patch.object(p,'protected',side_effect=lambda path,directory=False:Path(path).lstat()),patch.object(p,'cgroup_members',return_value=[]):
            yield registry,snapshots,parent

class ConsumerRefusals(unittest.TestCase):
    def test_gate_source_is_warning_free_and_git_failure_retains_bounded_evidence(self):
        # Future GHA only: compile bytes under a warning-as-error filter without
        # executing the module or writing pyc. The gate copies these exact bytes.
        with warnings.catch_warnings():
            warnings.simplefilter('error',SyntaxWarning)
            compile((HERE/'bank_import_worker_throughput_proof.py').read_bytes(),'gate-warning-control.py','exec',dont_inherit=True)
        result=SimpleNamespace(returncode=0,stdout='a'*40+'\n',stderr='')
        self.assertEqual(p.frozen_git_result(result,'rev-parse'),'a'*40)
        for code,stderr in [(128,'fictional fatal\n'),(0,'fictional warning\n'),(-9,''),(1,'x'*8192+'UNPRINTED_TAIL')]:
            with self.subTest(code=code,bytes=len(stderr)):
                with self.assertRaises(ValueError) as failure:
                    p.frozen_git_result(SimpleNamespace(returncode=code,stdout='PRIVATE_STDOUT_MUST_NOT_APPEAR',stderr=stderr),'status')
                message=str(failure.exception);detail=json.loads(message.split('frozen checkout Git check failed: ',1)[1])
                self.assertEqual(detail['operation'],'status');self.assertEqual(detail['exitCode'],code)
                self.assertEqual(detail['stderrBytes'],len(stderr.encode()));self.assertEqual(detail['stderrSha256'],p.digest(stderr.encode()))
                self.assertEqual(detail['stderrFirst4096Bytes'],stderr[:4096])
                self.assertNotIn('PRIVATE_STDOUT_MUST_NOT_APPEAR',message);self.assertNotIn('UNPRINTED_TAIL',message)
                self.assertEqual(set(detail),{'operation','exitCode','stderrBytes','stderrSha256','stderrFirst4096Bytes'})
        with self.assertRaises(ValueError): p.frozen_git_result(result,'arbitrary-operation')

    def test_mock_download_is_private_exclusive_and_bounded_under_permissive_umask(self):
        payload=b'fictional authenticated artifact bytes\n'
        class MockOpener:
            def open(inner,request,timeout):
                self.assertEqual(request.full_url,f'https://api.github.com/repos/{p.REPO}/actions/artifacts/303/zip')
                self.assertEqual(request.get_header('Authorization'),'Bearer fictional-token')
                self.assertEqual(timeout,60)
                return io.BytesIO(payload)
        with tempfile.TemporaryDirectory(prefix='throughput-download-controls-') as temporary:
            root=Path(temporary);archive=root/'artifact.zip';previous=os.umask(0)
            try:
                with patch.dict(os.environ,{'GH_TOKEN':'fictional-token'}),patch.object(p.urllib.request,'build_opener',return_value=MockOpener()):
                    p.download_artifact(303,archive,len(payload))
                    info=archive.lstat()
                    self.assertEqual(stat.S_IMODE(info.st_mode),0o600)
                    self.assertEqual(info.st_uid,os.geteuid());self.assertEqual(info.st_gid,os.getegid());self.assertEqual(info.st_nlink,1)
                    self.assertTrue(stat.S_ISREG(info.st_mode));self.assertFalse(archive.is_symlink())
                    self.assertEqual(p.file_hash(archive),p.digest(payload));self.assertEqual(archive.read_bytes(),payload)
                    with self.assertRaises(FileExistsError): p.download_artifact(303,archive,len(payload))
                    self.assertEqual(archive.read_bytes(),payload)
                    victim=root/'victim';victim.write_bytes(b'unchanged');link=root/'link';link.symlink_to(victim)
                    with self.assertRaises(OSError): p.download_artifact(303,link,len(payload))
                    self.assertEqual(victim.read_bytes(),b'unchanged')
                    with self.assertRaises(ValueError): p.download_artifact(303,root/'oversize.zip',len(payload)-1)
                    with self.assertRaises(ValueError): p.download_artifact(303,root/'short.zip',len(payload)+1)
                    with patch.object(p,'MAX_OUTER',len(payload)-1),self.assertRaises(ValueError): p.download_artifact(303,root/'outer-limit.zip',len(payload))
            finally: os.umask(previous)

    def test_launch_and_creation_window_failure_keep_durable_empty_ownership(self):
        with lifecycle_fixture() as (registry,snapshots,parent):
            # Popen cannot launch anything; the exact created inode was saved first.
            with patch.object(p.subprocess,'Popen',side_effect=OSError('injected launch failure')),self.assertRaises(OSError):
                registry.popen(['/owned/node'],env={'LANG':'C.UTF-8'})
            self.assertEqual(snapshots[0]['children'][0]['state'],'create-pending')
            self.assertEqual(snapshots[-1]['children'][0]['state'],'created')
            self.assertIsNotNone(snapshots[-1]['children'][0]['groupIdentity'])
            registry.remove_group(registry.data['children'][0]);self.assertEqual(registry.data['finishedChildren'],1)
        with lifecycle_fixture() as (registry,snapshots,parent):
            save=registry.save
            def interrupted_save():
                if registry.data['children'][0]['state']=='created': raise RuntimeError('death after mkdir before inode save')
                save()
            registry.save=interrupted_save
            with self.assertRaises(RuntimeError): registry.create_group([])
            registry.data=copy.deepcopy(snapshots[-1]);registry.save=save
            self.assertEqual(registry.data['children'][0]['state'],'create-pending')
            registry.remove_group(registry.data['children'][0]);self.assertEqual(registry.data['children'],[])

    def test_pre_release_parent_death_waits_for_eof_without_unknown_signal(self):
        with lifecycle_fixture() as (registry,snapshots,parent):
            group,record=registry.create_group([])
            # Model reload after parent death before ready/PID identity capture.
            registry.data=copy.deepcopy(snapshots[-1]);observations=0
            def members(path):
                nonlocal observations
                if path==group:
                    observations+=1
                    return [101] if observations==1 else []
                return []
            with patch.object(p,'cgroup_members',side_effect=members),patch.object(p.time,'sleep'),patch.object(p.os,'kill') as signal_child:
                registry.cleanup();signal_child.assert_not_called()
            self.assertEqual(registry.data['children'],[]);self.assertEqual(registry.data['namespace']['state'],'removed')
        with lifecycle_fixture() as (registry,snapshots,parent):
            group,record=registry.create_group([])
            with patch.object(p,'cgroup_members',return_value=[101]),patch.object(p.os,'kill') as signal_child,self.assertRaises(ValueError):
                # Pending inode adoption refuses unknown nonempty groups immediately.
                record['state']='create-pending';record['groupIdentity']=None;registry.group_for(record)
            signal_child.assert_not_called()

    def test_rmdir_before_save_recovers_only_durable_removal_intent(self):
        with lifecycle_fixture() as (registry,snapshots,parent):
            group,record=registry.create_group([]);save=registry.save
            def interrupted_save():
                if record['state']=='removed': raise RuntimeError('death after rmdir before save')
                save()
            registry.save=interrupted_save
            with self.assertRaises(RuntimeError): registry.remove_group(record)
            self.assertFalse(group.exists());self.assertEqual(snapshots[-1]['children'][0]['state'],'remove-pending')
            registry.data=copy.deepcopy(snapshots[-1]);registry.save=save
            registry.remove_group(registry.data['children'][0]);self.assertEqual(registry.data['finishedChildren'],1)
            registry.remove_namespace();self.assertEqual(registry.data['namespace']['state'],'removed')
        with lifecycle_fixture() as (registry,snapshots,parent):
            group,record=registry.create_group([]);group.rmdir()
            with self.assertRaises(ValueError): registry.group_for(record)
        with lifecycle_fixture() as (registry,snapshots,parent):
            save=registry.save
            def interrupted_namespace_save():
                if registry.data['namespace']['state']=='removed': raise RuntimeError('death after namespace rmdir')
                save()
            registry.save=interrupted_namespace_save
            with self.assertRaises(RuntimeError): registry.remove_namespace()
            self.assertFalse(parent.exists());self.assertEqual(snapshots[-1]['namespace']['state'],'remove-pending')
            registry.data=copy.deepcopy(snapshots[-1]);registry.save=save;registry.remove_namespace()
            self.assertEqual(registry.data['namespace']['state'],'removed')

    def test_all_five_worker_logs_are_closed_and_exportable(self):
        wanted={'latch-holder.stderr',*[f'worker-{i}.{kind}' for i in range(5) for kind in ['stdout','stderr']]}
        self.assertEqual(set(p.WORKER_LOG_NAMES),wanted);self.assertEqual(len(p.WORKER_LOG_NAMES),11)
        with tempfile.TemporaryDirectory(prefix='throughput-log-controls-') as temporary:
            root=Path(temporary)/'root';root.mkdir();destination=Path(temporary)/'bank-throughput-evidence';destination.mkdir(mode=0o700)
            for name in wanted: (root/('cleanup-'+name)).write_bytes(b'fictional bounded log\n')
            with patch.object(p,'protected',side_effect=lambda path,directory=False:Path(path).lstat()),patch.dict(os.environ,{'SUDO_UID':str(destination.stat().st_uid)}):
                p.export_cleanup_evidence(root,destination)
            self.assertEqual({path.name for path in destination.iterdir()},{'owned-cleanup-'+name for name in wanted})
            self.assertTrue((destination/'owned-cleanup-worker-4.stderr').exists())

    def test_exact_owned_identity_refuses_reused_or_foreign_process(self):
        actual={'pid':101,'parent':99,'start':'2001','uid':['6001']*4,'gid':['6002']*4,'exe':'/owned/node','cwd':'/owned/runtime','argv':[b'/owned/node',b'--import',b'tsx'],'env':b'NODE_ENV=production\0'}
        expected=p.serial_identity(actual)
        record={'pid':101,'start':'2001','parent':99,'parentStart':'1900','gate':expected,'exec':expected}
        registry=object.__new__(p.Registry)
        with patch.object(p,'proc_snapshot',return_value=actual): self.assertEqual(registry.owned(record),actual)
        for key,value in [('start','2002'),('uid',['6003']*4),('gid',['6004']*4),('exe','/foreign/node'),('cwd','/foreign/runtime'),('argv',[b'/foreign/node']),('env',b'NODE_ENV=test\0')]:
            changed={**actual,key:value}
            with self.subTest(key=key),patch.object(p,'proc_snapshot',return_value=changed),self.assertRaises(ValueError): registry.owned(record)
        changed={**actual,'parent':88}
        with patch.object(p,'proc_snapshot',side_effect=[changed,{'start':'1900'}]),self.assertRaises(ValueError): registry.owned(record)
        with patch.object(p,'proc_snapshot',side_effect=[changed,FileNotFoundError()]): self.assertEqual(registry.owned(record),changed)

    def test_explicit_source_and_strict_types(self):
        self.assertEqual(p.source_pin('a'*40),'a'*40)
        for value in [p.REFUSED_SOURCE,'A'*40,'a'*39,None,True]:
            with self.assertRaises(ValueError): p.source_pin(value)
        self.assertFalse(p.exact({'rows':True},{'rows':1}))
        for value in ['0','-1','1/zip','https://example.invalid/1','9007199254740992']:
            with self.assertRaises(ValueError): p.number(value)

    def test_entire_job_budget_and_evidence_reserve(self):
        started=p.parse_time('2026-10-29T00:00:00Z')
        with patch.dict(os.environ,{'THROUGHPUT_PROOF_MODE':'full-100001'}):
            self.assertEqual(p.remaining_job_seconds('2026-10-29T00:00:00Z',started+600,started+10),9900)
            self.assertEqual(p.remaining_job_seconds('2026-10-29T00:00:00Z',started+1200,started+10),9300)
            for now,first in [(started+10000,started+10),(started-1,started),(started+60,float('nan'))]:
                with self.assertRaises(ValueError): p.remaining_job_seconds('2026-10-29T00:00:00Z',now,first)
        with patch.dict(os.environ,{'THROUGHPUT_PROOF_MODE':'preflight-401'}):
            self.assertEqual(p.remaining_job_seconds('2026-10-29T00:00:00Z',started,started),900)
            self.assertEqual(p.remaining_job_seconds('2026-10-29T00:00:00Z',started+600,started+10),300)
            self.assertEqual(p.remaining_job_seconds('2026-10-29T00:00:00Z',started+840,started+10),60)
            with self.assertRaises(ValueError): p.remaining_job_seconds('2026-10-29T00:00:00Z',started+841,started+10)

    def test_authenticated_first_attempt_closed_identity(self):
        pins={'producer':'a'*40,'source':'b'*40,'run':101,'job':202,'artifact':303,'digest':'c'*64}
        run={'id':101,'run_attempt':1,'event':'workflow_dispatch','path':p.PRODUCER_WORKFLOW,'head_sha':'a'*40,'status':'completed','conclusion':'success','repository':{'id':p.REPOSITORY_ID,'full_name':p.REPO},'head_repository':{'id':p.REPOSITORY_ID,'full_name':p.REPO}}
        job={'id':202,'name':'worker-package','run_id':101,'run_attempt':1,'head_sha':'a'*40,'status':'completed','conclusion':'success','labels':['ubuntu-24.04'],'started_at':'2026-10-29T00:00:00Z','completed_at':'2026-10-29T00:10:00Z'}
        artifact={'id':303,'name':'worker-package-v2','expired':False,'digest':'sha256:'+'c'*64,'size_in_bytes':123,'created_at':'2026-10-29T00:09:00Z','workflow_run':{'id':101,'head_sha':'a'*40,'repository_id':p.REPOSITORY_ID,'head_repository_id':p.REPOSITORY_ID}}
        p.check_metadata(run,[job],artifact,pins)
        mutations=[('run','run_attempt',2),('run','conclusion','failure'),('run','path','other.yml'),('job','id',True),('job','labels',['ubuntu-latest']),('artifact','expired',True),('artifact','digest','sha256:'+'d'*64),('artifact','size_in_bytes',p.MAX_OUTER+1),('artifact','created_at','2026-10-29T01:00:00Z')]
        for kind,key,value in mutations:
            values={'run':copy.deepcopy(run),'job':copy.deepcopy(job),'artifact':copy.deepcopy(artifact)};values[kind][key]=value
            with self.subTest(kind=kind,key=key),self.assertRaises(ValueError): p.check_metadata(values['run'],[values['job']],values['artifact'],pins)
        with self.assertRaises(ValueError): p.check_metadata(run,[job,job],artifact,pins)
        foreign=copy.deepcopy(run);foreign['head_repository']['id']=p.REPOSITORY_ID+1
        with self.assertRaises(ValueError): p.check_metadata(foreign,[job],artifact,pins)

    def test_closed_outer_zip_refuses_extras_duplicates_and_links(self):
        with tempfile.TemporaryDirectory(prefix='throughput-zip-controls-') as temporary:
            root=Path(temporary)
            for index,variant in enumerate(['valid','extra','duplicate','link','traversal']):
                archive=root/f'{index}.zip'
                with warnings.catch_warnings():
                    warnings.simplefilter('ignore',UserWarning)
                    with zipfile.ZipFile(archive,'w') as z:
                        for name in p.MEMBERS:
                            item=zipfile.ZipInfo(name);item.external_attr=(0o120777 if variant=='link' and name=='worker-package.zip' else 0o100600)<<16;z.writestr(item,b'fixture')
                        if variant=='extra': z.writestr('extra',b'fixture')
                        if variant=='duplicate': z.writestr('worker-package.zip',b'fixture')
                        if variant=='traversal': z.writestr('../outside',b'fixture')
                if variant=='valid': self.assertEqual(set(p.extract_packet(archive,root/f'out-{index}',p.file_hash(archive))),set(p.MEMBERS))
                else:
                    with self.assertRaises(ValueError): p.extract_packet(archive,root/f'out-{index}',p.file_hash(archive))
            with self.assertRaises(ValueError): p.extract_packet(root/'0.zip',root/'wrong-digest','0'*64)
            self.assertFalse((root/'outside').exists())

    def test_ordinary_ledger_is_derived_and_not_a_staging_claim(self):
        with tempfile.TemporaryDirectory(prefix='throughput-ledger-controls-') as temporary:
            root=Path(temporary);folder=root/'db/migrations';(folder/'meta').mkdir(parents=True)
            entries=[{'idx':7,'when':1001,'tag':'0007_first'},{'idx':9,'when':1002,'tag':'0009_second'}]
            (folder/'meta/_journal.json').write_text(json.dumps({'entries':entries}))
            (folder/'0007_first.sql').write_text('SELECT 1;\n');(folder/'0009_second.sql').write_text('SELECT 2;\n')
            before=p.ordinary_source_ledger(root)
            self.assertEqual(before['rows'],2);self.assertEqual(before['kind'],'FRESH_ORDINARY_SOURCE_JOURNAL_NOT_STAGING_LEDGER')
            (folder/'0009_second.sql').write_text('SELECT 3;\n')
            self.assertNotEqual(before['sha256'],p.ordinary_source_ledger(root)['sha256'])
            with self.assertRaises(ValueError): p.require_registered_policy(root)
            entries[1]['tag']=entries[0]['tag'];(folder/'meta/_journal.json').write_text(json.dumps({'entries':entries}))
            with self.assertRaises(ValueError): p.ordinary_source_ledger(root)
        # Complete immutable source581 fixtures; never a synthetic tiny journal
        # accepted by the finite contract. Hash inventory came from actual2de Git SQL bytes.
        raw=(HERE/'fixtures/bank-consumer-581-journal.json').read_bytes();journal=json.loads(raw)
        fixture=json.loads((HERE/'fixtures/bank-consumer-581-sql-hashes.json').read_bytes())
        self.assertEqual(fixture['source'],'2de3f58bb53536d974d1c34d09a08a185237b6e2')
        self.assertEqual(p.digest(raw),'0ec4efea88ff081124c96922f3f84988e4dc1e082a7e46d25d2ae7b59550137e')
        self.assertEqual(len(journal['entries']),581);self.assertEqual(len(fixture['ordinarySql']),581)
        self.assertEqual(p.digest(p.canonical(journal['entries'][:580])),'85d457d4d2ab8d616ef1ddfa245559038f45754da3560b126d690c701ba740a8')
        self.assertEqual([row['created_at'] for row in fixture['ordinarySql']],[str(row['when']) for row in journal['entries']])
        def fixture_ledger(rows):
            return {'kind':'FRESH_ORDINARY_SOURCE_JOURNAL_NOT_STAGING_LEDGER','rows':len(rows),'sha256':p.digest(json.dumps(rows,sort_keys=True,separators=(',',':')).encode()),'journalSha256':p.digest(raw)}
        ledger=fixture_ledger(fixture['ordinarySql']);self.assertEqual(ledger['sha256'],'38d86c3d2a32cc1203ca8f6456d43da4ee4c1dd65a424f25cdda6881920a7973')
        with tempfile.TemporaryDirectory(prefix='throughput-581-bank-sql-') as temporary:
            bank=Path(temporary)/'0691_bank_import_point_read.sql';bank.write_bytes(fixture['bankSql'].encode())
            original=p.file_hash(bank);self.assertEqual(original,'be6f8d38850fadd9151d58ea7476d8f60e09a0bf2b2b078e0196f4cb90c5bfe9')
            p.validate_581_policy_contract(raw,ledger,original)
            bank.write_bytes(bank.read_bytes()+b'\n-- actual changed SQL byte control\n')
            altered=p.file_hash(bank);self.assertNotEqual(altered,original)
            with self.assertRaises(ValueError): p.validate_581_policy_contract(raw,ledger,altered)
            changed_sql=copy.deepcopy(fixture['ordinarySql']);changed_sql[-1]['hash']=altered
            with self.assertRaises(ValueError): p.validate_581_policy_contract(raw,fixture_ledger(changed_sql),original)
            routed=Path(temporary)/'source';meta=routed/'db/migrations/meta';meta.mkdir(parents=True)
            (meta/'_journal.json').write_bytes(raw)
            (meta.parent/'0691_bank_import_point_read.sql').write_bytes(fixture['bankSql'].encode())
            # Only the expensive ALL-SQL I/O derivation is supplied as a fixture;
            # production routing and the finite validator remain real and strict.
            with patch.object(p,'ordinary_source_ledger',return_value=ledger) as derived:
                p.require_registered_policy(routed);derived.assert_called_once_with(routed)
            with patch.object(p,'ordinary_source_ledger',return_value={**ledger,'sha256':'0'*64}),self.assertRaises(ValueError): p.require_registered_policy(routed)
        mutations=[]
        for position,key,value in [(0,'tag','unknown_prefix'),(0,'idx',9999),(578,'when',1793330000064),(579,'when',1793330000064),(580,'idx',681),(580,'when',1793330000017)]:
            changed=copy.deepcopy(journal);changed['entries'][position][key]=value;mutations.append(changed)
        changed=copy.deepcopy(journal);changed['entries'][0],changed['entries'][1]=changed['entries'][1],changed['entries'][0];mutations.append(changed)
        changed=copy.deepcopy(journal);changed['entries'][579]=copy.deepcopy(changed['entries'][580]);mutations.append(changed)
        changed=copy.deepcopy(journal);changed['entries'].pop();mutations.append(changed)
        for changed in mutations:
            with self.subTest(tail=changed['entries'][-1]),self.assertRaises(ValueError): p.validate_581_policy_contract(p.canonical(changed),ledger,original)
        with self.assertRaises(ValueError): p.validate_581_policy_contract(raw+b' ',ledger,original)
        for key,value in [('rows',580),('rows',True),('kind','STAGING_LEDGER'),('journalSha256','0'*64),('sha256','0'*64)]:
            changed={**ledger,key:value}
            with self.subTest(ledger_key=key),self.assertRaises(ValueError): p.validate_581_policy_contract(raw,changed,original)

    def test_new_producer_contract_is_closed_and_strict(self):
        fmt=SimpleNamespace(canonical=p.canonical,RUNTIME={'node':'22.23.3','abi':'127','platform':'linux','arch':'x64','glibc':'2.39'})
        manifest={'producerSha256':'1'*64,'formatSha256':'2'*64,'packageSha256':'3'*64,'lockSha256':'4'*64,'runtime':fmt.RUNTIME,'entries':[]}
        ledger={'kind':'FRESH_ORDINARY_SOURCE_JOURNAL_NOT_STAGING_LEDGER','rows':567,'sha256':'5'*64,'journalSha256':'6'*64}
        provenance={'format':2,'kind':'WORKER_BYTES_ONLY_NOT_RELEASE_AUTHORITY','source':'a'*40,'controllerSource':'b'*40,'producerSha256':manifest['producerSha256'],'formatSha256':manifest['formatSha256'],'runtime':fmt.RUNTIME,'archiveSha256':'7'*64,'archiveBytes':123,'manifestSha256':p.digest(p.canonical(manifest)),'packageSha256':manifest['packageSha256'],'lockSha256':manifest['lockSha256'],'entries':0,'unpackedBytes':0}
        proof={'format':1,'kind':'CI_EXTRACTED_WORKER_RUNTIME_NOT_RELEASE','source':'a'*40,'controllerSource':'b'*40,'producerSha256':manifest['producerSha256'],'formatSha256':manifest['formatSha256'],'archiveSha256':'7'*64,'manifestSha256':p.digest(p.canonical(manifest)),'provenanceSha256':p.digest(p.canonical(provenance)),'packageSha256':manifest['packageSha256'],'lockSha256':manifest['lockSha256'],'runtime':fmt.RUNTIME,'runId':42,'runAttempt':1,'rootOwnedReadOnly':True,'extractedOutsideCheckout':True,'modulePathsClean':True,'sourceDependencyBytesVerified':True,'extractedPostRunVerified':True,'releaseAuthorized':False,'migrationLedger':ledger,'roleProof':[{'rolname':'ai_hr_app','rolsuper':False,'rolbypassrls':False,'queue_owner':False},{'rolname':'ai_hr_owner','rolsuper':False,'rolbypassrls':False,'queue_owner':True}],'emptyQueue':{'before':0,'after':0,'publicTables':20,'contentSha256':'8'*64,'noHrMutation':True,'exitCode':0,'stdoutSha256':p.digest(b''),'stderrSha256':p.digest(b'')},'nativeFixture':{'syntheticOnly':True,'previewValid':1,'previewInvalid':1,'previewHrUnchanged':True,'saved':1,'failed':0,'total':2,'processed':2,'auditItems':1,'sourceChunksReleased':True,'nativeAuditOrdinals':[1],'nativeCheckpoint':[{'ordinal':1,'state':'applied'},{'ordinal':2,'state':'invalid'}],'cliInvocations':5},'cli':{'invocations':6,'exitCodes':[0]*6,'noUnexpectedStderr':True}}
        def validate(value): return p.validate_runtime_witness(value,'a'*40,'b'*40,'7'*64,123,manifest,ledger,42,fmt)
        self.assertEqual(validate(proof),provenance)
        for key,value in [('sourceDependencyBytesVerified',False),('releaseAuthorized',True),('runAttempt',2),('migrationLedger','legacy-staging-digest'),('cli',{'invocations':1,'exitCodes':[0],'noUnexpectedStderr':True})]:
            changed=copy.deepcopy(proof);changed[key]=value
            with self.subTest(key=key),self.assertRaises(ValueError): validate(changed)
        for key in ['sourceDependencyBytesVerified','nativeFixture']:
            changed=copy.deepcopy(proof);del changed[key]
            with self.assertRaises(ValueError): validate(changed)
        changed=copy.deepcopy(proof);changed['nativeFixture']['nativeAuditOrdinals']=[True]
        with self.assertRaises(ValueError): validate(changed)
        changed=copy.deepcopy(proof);changed['unexpected']='extra'
        with self.assertRaises(ValueError): validate(changed)

if __name__=='__main__':
    if not (os.environ.get('GITHUB_ACTIONS')=='true' and os.environ.get('CI')=='true' and os.uname().sysname=='Linux'):
        raise SystemExit('Consumer controls require disposable GitHub Linux CI; no local execution.')
    unittest.main()
