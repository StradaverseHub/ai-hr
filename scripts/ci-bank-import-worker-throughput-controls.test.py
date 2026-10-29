"""Pure consumer refusal controls, executed only by the future GitHub Linux workflow.
No application import, native process, database, network or release authority.
"""
import copy
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch
import warnings
import zipfile

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('throughput_controls_subject',HERE/'bank_import_worker_throughput_proof.py')
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)

class ConsumerRefusals(unittest.TestCase):
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
        self.assertEqual(p.remaining_job_seconds('2026-10-29T00:00:00Z',started+600,started+10),9900)
        self.assertEqual(p.remaining_job_seconds('2026-10-29T00:00:00Z',started+1200,started+10),9300)
        for now,first in [(started+10000,started+10),(started-1,started),(started+60,float('nan'))]:
            with self.assertRaises(ValueError): p.remaining_job_seconds('2026-10-29T00:00:00Z',now,first)

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
