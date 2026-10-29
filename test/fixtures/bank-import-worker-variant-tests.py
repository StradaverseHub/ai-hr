import sys
sys.dont_write_bytecode=True
import copy
import hashlib
import importlib.util
from pathlib import Path
import signal
import tempfile
from types import SimpleNamespace
import unittest

ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,ROOT/path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
fmt=load('fmt','deploy/systemd/bank_import_worker_format.py')
install=load('install','deploy/systemd/bank_import_worker_installer_v2.py')
variant=load('variant','deploy/systemd/bank_import_worker_variant.py')
recovery=load('recovery','deploy/systemd/bank_import_worker_recovery.py')

class VariantTests(unittest.TestCase):
    def setUp(self):
        self.source=variant.KNOWN_SOURCE;self.controller='2'*40;self.archive='5'*64;self.ledger='6'*64
        self.ops=SimpleNamespace(ROOT=install.ROOT,check=install.check,service_unit=install.service_unit,root_protected=lambda *a,**k:None,read_bounded=install.read_bounded)
        self.manifest={'format':2,'kind':'bank-import-worker-package-v2','source':self.source,'controllerSource':self.controller,'producerSha256':'3'*64,'formatSha256':'4'*64,'runtime':fmt.RUNTIME.copy(),'lockSha256':'7'*64,'packageSha256':'8'*64,'entries':[]}
        manifest_hash=fmt.digest(fmt.canonical(self.manifest))
        provenance={'format':2,'kind':'WORKER_BYTES_ONLY_NOT_RELEASE_AUTHORITY','source':self.source,'controllerSource':self.controller,'producerSha256':'3'*64,'formatSha256':'4'*64,'runtime':fmt.RUNTIME.copy(),'archiveSha256':self.archive,'archiveBytes':1234,'manifestSha256':manifest_hash,'packageSha256':'8'*64,'lockSha256':'7'*64,'entries':0,'unpackedBytes':0}
        self.proof={'format':1,'kind':'CI_EXTRACTED_WORKER_RUNTIME_NOT_RELEASE','source':self.source,'controllerSource':self.controller,'producerSha256':'3'*64,'formatSha256':'4'*64,'archiveSha256':self.archive,'manifestSha256':manifest_hash,'provenanceSha256':fmt.digest(fmt.canonical(provenance)),'packageSha256':'8'*64,'lockSha256':'7'*64,'runtime':fmt.RUNTIME.copy(),'runId':123,'runAttempt':1,'rootOwnedReadOnly':True,'extractedOutsideCheckout':True,'modulePathsClean':True,'extractedPostRunVerified':True,'releaseAuthorized':False,'roleProof':[{'rolname':'ai_hr_app','rolsuper':False,'rolbypassrls':False,'queue_owner':False},{'rolname':'ai_hr_owner','rolsuper':False,'rolbypassrls':False,'queue_owner':True}],'migrationLedger':{'rows':562,'sha256':self.ledger},'emptyQueue':{'before':0,'after':0,'publicTables':10,'contentSha256':'9'*64,'noHrMutation':True,'exitCode':0,'stdoutSha256':fmt.digest(b''),'stderrSha256':fmt.digest(b'')},'nativeFixture':{'syntheticOnly':True,'previewValid':1,'previewInvalid':1,'previewHrUnchanged':True,'saved':1,'failed':0,'total':2,'processed':2,'auditItems':1,'sourceChunksReleased':True,'cliInvocations':5},'cli':{'invocations':6,'exitCodes':[0]*6,'noUnexpectedStderr':True}}
    def witness(self,proof=None,ledger=None):
        variant.validate_runtime_witness(proof or self.proof,self.source,self.controller,self.archive,1234,self.manifest,ledger or self.ledger,123,fmt,self.ops)
    def test_fixed_variant_changes_only_working_directory_and_rejects_injected_identity(self):
        old=install.service_unit(self.source).encode();new=variant.variant_unit(self.source,self.archive,self.ops)
        expected=old.replace(('WorkingDirectory=/opt/aihr-import/releases/'+self.source+'\n').encode(),('WorkingDirectory=/opt/aihr-import/releases/'+self.source+'-'+self.archive+'\n').encode())
        self.assertEqual(new,expected)
        with self.assertRaises(ValueError): variant.variant_unit(self.source,self.archive+'\nUser=root',self.ops)
    def test_runtime_proof_requires_exact_controller_archive_provenance_and_schema(self):
        self.witness()
        for key,value in [('controllerSource','0'*40),('archiveSha256','0'*64),('provenanceSha256','0'*64),('runAttempt',2),('releaseAuthorized',True),('unreviewed',True)]:
            proof=copy.deepcopy(self.proof);proof[key]=value
            with self.assertRaises(ValueError): self.witness(proof)
    def test_runtime_proof_rejects_wrong_ledger_privileged_roles_missing_native_save_and_bool_integer(self):
        with self.assertRaises(ValueError): self.witness(ledger='0'*64)
        for mutate in [lambda p:p['roleProof'][0].update(rolbypassrls=True),lambda p:p['nativeFixture'].update(saved=0),lambda p:p['nativeFixture'].update(previewValid=True),lambda p:p['cli'].update(noUnexpectedStderr=False)]:
            proof=copy.deepcopy(self.proof);mutate(proof)
            with self.assertRaises(ValueError): self.witness(proof)
    def test_signal_after_atomic_unit_replace_restores_exact_old_unit_after_confirmed_stop(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'unit';path.write_bytes(b'old');events=[]
            self.ops.UNIT=path;self.ops.stop_owned_first_install=lambda:events.append('confirmed-stop-disable')
            self.ops.command=lambda argv:events.append('reload')
            with self.assertRaises(install.ActivationInterrupted):
                with install.activation_guard(lambda:variant.restore_unit_after_failure(b'old',b'new',self.ops)):
                    variant.atomic_unit_replace(path,b'old',b'new',self.ops)
                    signal.raise_signal(signal.SIGHUP)
            self.assertEqual(path.read_bytes(),b'old');self.assertEqual(events,['confirmed-stop-disable','reload'])
    def test_failed_stop_or_unexpected_unit_prevents_rollback_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'unit';path.write_bytes(b'new');self.ops.UNIT=path
            def failed(): raise RuntimeError('stop not confirmed')
            self.ops.stop_owned_first_install=failed
            with self.assertRaises(RuntimeError): variant.restore_unit_after_failure(b'old',b'new',self.ops)
            self.assertEqual(path.read_bytes(),b'new')
            stops=[];self.ops.stop_owned_first_install=lambda:stops.append('stop');path.write_bytes(b'foreign')
            with self.assertRaises(ValueError): variant.restore_unit_after_failure(b'old',b'new',self.ops)
            self.assertEqual(path.read_bytes(),b'foreign');self.assertEqual(stops,[])
    def test_refusal_before_unit_mutation_does_not_stop_service(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'unit';path.write_bytes(b'old');events=[];self.ops.UNIT=path
            self.ops.stop_owned_first_install=lambda:events.append('UNEXPECTED-stop')
            with self.assertRaisesRegex(ValueError,'refused before mutation'):
                with install.activation_guard(lambda:variant.restore_unit_after_failure(b'old',b'new',self.ops)):
                    raise ValueError('refused before mutation')
            self.assertEqual(events,[]);self.assertEqual(path.read_bytes(),b'old')
    def test_fresh_preownership_check_refuses_foreign_start_without_cleanup(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'unit';path.write_bytes(b'old');events=[]
            commands={key:{'type':'a(sasbttttuii)','data':[]} for key in ['ExecStartPre','ExecStartPost','ExecStop','ExecStopPost','ExecCondition']}
            commands['ExecStart']={'type':'a(sasbttttuii)','data':[[str(install.NODE),[str(install.NODE),'--import','tsx','scripts/bank-import-runner.ts'],False,0,0,0,0,0,0,0]]}
            properties={'ActiveState':'inactive','SubState':'dead','UnitFileState':'disabled','MainPID':'0','NRestarts':'0','_commands':commands}
            self.ops.UNIT=path;self.ops.USER='test-worker';self.ops.service_properties=lambda:properties
            self.ops.validate_service=lambda *args:events.append('typed-service-verified')
            self.ops.never_started=recovery.never_started
            self.ops.validate_command_proofs=install.validate_command_proofs
            result=SimpleNamespace(returncode=1,stdout='');self.ops.command=lambda *args,**kwargs:result
            self.ops.stop_owned_first_install=lambda:events.append('UNEXPECTED-stop')
            variant.verify_inactive_before_ownership(b'old',Path(tmp),self.ops)
            for changes in [{'ActiveState':'active','MainPID':'123'},{'NRestarts':'1'}]:
                previous=properties.copy();properties.update(changes)
                with self.assertRaises(ValueError): variant.verify_inactive_before_ownership(b'old',Path(tmp),self.ops)
                properties.clear();properties.update(previous)
            result.returncode=0;result.stdout='123\n'
            with self.assertRaises(ValueError): variant.verify_inactive_before_ownership(b'old',Path(tmp),self.ops)
            path.write_bytes(b'foreign')
            with self.assertRaises(ValueError): variant.verify_inactive_before_ownership(b'old',Path(tmp),self.ops)
            self.assertNotIn('UNEXPECTED-stop',events);self.assertEqual(path.read_bytes(),b'foreign')

unittest.main()
