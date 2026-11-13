"""Managed update refusal controls. No root operations, live services, credentials or DBs."""
import sys
sys.dont_write_bytecode=True
import hashlib
import json
import os
import contextlib
from contextlib import ExitStack
import io
import traceback
import importlib.util
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('worker_update',ROOT/'deploy/systemd/bank_import_worker_upgrade_v1.py')
update=importlib.util.module_from_spec(spec);spec.loader.exec_module(update)

def check(ok,message):
    if not ok: raise ValueError(message)

class WorkerUpgradeTests(unittest.TestCase):
    def setUp(self):
        self.active={'MainPID':'123','ActiveState':'active','SubState':'running','NRestarts':'0','Result':'success','ExecMainStatus':'0'}
        self.dead={**self.active,'MainPID':'0','ActiveState':'inactive','SubState':'dead'}
        self.base=SimpleNamespace(ROOT=Path('/opt/aihr-import'),check=check,validate_service=lambda *_:None,command=lambda *_:None)
    def run_drain(self,reports):
        calls=[]
        self.base.command=lambda argv:calls.append(argv)
        with patch.object(update,'validate_process',return_value=123),patch.object(update,'properties',side_effect=reports),patch.object(update.time,'sleep'):
            result=update.drain(self.base,self.active,'1'*40)
        return result,calls
    def test_drains_with_managed_term_without_stop_disable_or_force_kill(self):
        result,calls=self.run_drain([self.active,self.active,self.dead,self.dead])
        self.assertEqual(result,{'pid':123,'state':'drained','forcedKill':False})
        self.assertEqual(calls,[['/usr/bin/systemctl','kill','--kill-whom=main','--signal=SIGTERM','aihr-bank-import.service']])
    def test_accepts_normal_deactivation_without_restart_or_pid_change(self):
        result,_=self.run_drain([self.active,{**self.active,'ActiveState':'deactivating'},self.dead,self.dead])
        self.assertEqual(result['state'],'drained')
    def test_refuses_changed_service_before_signalling(self):
        calls=[];self.base.command=lambda argv:calls.append(argv)
        with patch.object(update,'validate_process',return_value=123),patch.object(update,'properties',return_value={**self.active,'MainPID':'456'}):
            with self.assertRaisesRegex(ValueError,'changed before'):update.drain(self.base,self.active,'1'*40)
        self.assertEqual(calls,[])
    def test_refuses_a_restarted_worker(self):
        with self.assertRaisesRegex(ValueError,'restarted'):
            self.run_drain([self.active,{**self.active,'NRestarts':'1','MainPID':'456'}])
    def test_refuses_pid_change_even_without_counter_change(self):
        with self.assertRaisesRegex(ValueError,'PID changed'):
            self.run_drain([self.active,{**self.active,'MainPID':'456'}])
    def test_refuses_failed_or_nonzero_exit(self):
        for report in [{**self.dead,'Result':'exit-code'},{**self.dead,'ExecMainStatus':'1'}]:
            with self.assertRaisesRegex(ValueError,'exit successfully'):self.run_drain([self.active,report])
    def test_refuses_unstable_drained_state(self):
        with self.assertRaisesRegex(ValueError,'remain drained'):
            self.run_drain([self.active,self.dead,self.active])
    def test_deadline_never_escalates_to_kill_or_advances_installation(self):
        calls=[];self.base.command=lambda argv:calls.append(argv)
        with patch.object(update,'validate_process',return_value=123),patch.object(update,'properties',return_value=self.active),patch.object(update.time,'monotonic',side_effect=[0,331]):
            with self.assertRaisesRegex(RuntimeError,'deadline reached'):update.drain(self.base,self.active,'1'*40)
        self.assertEqual(len(calls),1);self.assertIn('--signal=SIGTERM',calls[0])
    def test_atomic_replacement_refuses_changed_unit_and_preserves_original(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'worker.service';path.write_bytes(b'prior')
            base=SimpleNamespace(UNIT=path,root_protected=lambda *_:None,check=check,read_bounded=lambda path,limit:path.read_bytes())
            with self.assertRaisesRegex(ValueError,'unit changed'):update.atomic_unit(base,b'new','0'*64)
            self.assertEqual(path.read_bytes(),b'prior');self.assertEqual(list(Path(tmp).iterdir()),[path])
            update.atomic_unit(base,b'new',hashlib.sha256(b'prior').hexdigest())
            self.assertEqual(path.read_bytes(),b'new');self.assertEqual(path.stat().st_mode&0o777,0o644)
    def test_atomic_replacement_rechecks_root_protection(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'worker.service';path.write_bytes(b'prior')
            def refuse(*_):raise ValueError('unprotected parent')
            base=SimpleNamespace(UNIT=path,root_protected=refuse)
            with self.assertRaisesRegex(ValueError,'unprotected'):update.atomic_unit(base,b'new','0'*64)
            self.assertEqual(path.read_bytes(),b'prior')
    def process_fixture(self,root):
        proc=root/'proc';process=proc/'123';process.mkdir(parents=True)
        releases=root/'app'/'releases';release=releases/('1'*40);release.mkdir(parents=True)
        (process/'cwd').symlink_to(release,target_is_directory=True)
        node=root/'node';(process/'cmdline').write_bytes(str(node).encode()+b'\0--import\0tsx\0scripts/bank-import-runner.ts\0')
        (process/'environ').write_bytes(b'DATABASE_URL=fictional\0PATH=/usr/bin\0')
        env=root/'worker.env';env.write_text('DATABASE_URL="fictional"\n')
        base=SimpleNamespace(USER='fictional',ROOT=root/'app',NODE=node,ENV=env,ENV_KEYS={'DATABASE_URL'},check=check,read_bounded=lambda p,limit:p.read_bytes())
        return proc,process,base
    def test_live_process_validation_checks_actual_uid_source_command_and_selected_environment(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc,process,base=self.process_fixture(Path(tmp));uid=process.stat().st_uid
            with patch.object(update,'Path',side_effect=lambda value:proc if value=='/proc' else Path(value)),patch.object(update.pwd,'getpwnam',return_value=SimpleNamespace(pw_uid=uid)):
                self.assertEqual(update.validate_process(base,self.active,'1'*40),123)
    def test_live_process_validation_refuses_uid_source_command_environment_and_loader_drift(self):
        for defect in ['uid','source','command','environment','loader','inactive']:
            with self.subTest(defect=defect),tempfile.TemporaryDirectory() as tmp:
                proc,process,base=self.process_fixture(Path(tmp));uid=process.stat().st_uid;report=dict(self.active)
                if defect=='uid':uid+=1
                if defect=='source':(process/'cwd').unlink();(process/'cwd').symlink_to(Path(tmp),target_is_directory=True)
                if defect=='command':(process/'cmdline').write_bytes(b'/bin/sh\0')
                if defect=='environment':(process/'environ').write_bytes(b'DATABASE_URL=changed\0')
                if defect=='loader':(process/'environ').write_bytes(b'DATABASE_URL=fictional\0NODE_OPTIONS=unreviewed\0')
                if defect=='inactive':report.update(MainPID='0',ActiveState='inactive')
                with patch.object(update,'Path',side_effect=lambda value:proc if value=='/proc' else Path(value)),patch.object(update.pwd,'getpwnam',return_value=SimpleNamespace(pw_uid=uid)):
                    with self.assertRaises(ValueError):update.validate_process(base,report,'1'*40)
    def test_bundle_is_self_contained_and_does_not_load_mutable_web_modules(self):
        with tempfile.TemporaryDirectory() as tmp:
            output=Path(tmp)/'helper.py'
            result=subprocess.run([sys.executable,'-I','-B',str(ROOT/'scripts/bank-import-worker-upgrade-bundle.py'),str(output)],capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(json.loads(result.stdout)['phases'],['drain','activate','adopt-stopped'])
            body=output.read_text();self.assertNotIn('spec_from_file_location',body)
            self.assertIn('types.ModuleType',body);self.assertEqual(output.stat().st_mode&0o777,0o600)
            result=subprocess.run([sys.executable,'-I','-B',str(output),'--help'],capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            for flag in ['previous-web-source','previous-web-build','previous-worker-source','adopt-stopped','observed-unit-sha256']:self.assertIn(flag,result.stdout)
            self.assertIn('{drain,activate,adopt-stopped}',result.stdout)
            refused=subprocess.run([sys.executable,'-I','-B',str(output),'adopt-stopped','--unit-sha256','e'*64],capture_output=True,text=True)
            self.assertNotEqual(refused.returncode,0);self.assertIn('is required for adopt-stopped',refused.stderr)
            duplicate=subprocess.run([sys.executable,'-I','-B',str(ROOT/'scripts/bank-import-worker-upgrade-bundle.py'),str(output)],capture_output=True,text=True)
            self.assertNotEqual(duplicate.returncode,0)

class UpgradeFlowFixture:
    """Real temporary files; deterministic systemd/proc/privilege adapters only."""
    def __init__(self,root,previous_web=None):
        self.root=root;self.events=[];self.fault=None;self.used_fault=False
        self.web_active=True;self.health_status=200;self.health_body=b'{"status":"ok"}\n'
        self.previous_worker='1'*40;self.previous_web=previous_web or self.previous_worker
        self.source='2'*40;self.old_build='old-build';self.new_build='new-build';self.web=self.previous_web
        self.app=root/'app';self.app.mkdir();(self.app/'releases').mkdir()
        self.unit=root/'worker.service';self.env=root/'worker.env';self.env.write_bytes(b'DATABASE_URL="fictional"\n')
        self.archive=root/'package.zip';self.archive.write_bytes(b'authenticated fictional archive')
        self.node=root/'node';self.node.write_text('fictional')
        self.old_release=self.app/'releases'/self.previous_worker;self.old_release.mkdir()
        self.report={'MainPID':'123','ActiveState':'active','SubState':'running','NRestarts':'0','Result':'success','ExecMainStatus':'0','Restart':'on-failure','SendSIGKILL':'yes','NeedDaemonReload':'no','UnitFileState':'enabled'}
        self.base=SimpleNamespace(ROOT=self.app,NODE=self.node,UNIT=self.unit,ENV=self.env,USER='fictional',check=check,command=self.command,
            root_protected=self.protected,read_bounded=lambda p,limit:p.read_bytes(),service_unit=self.service_unit,
            deployment_state=self.deployment,validate_service=lambda *_:None,write_new=self.write_new,
            install_lock_directory=lambda:root,snapshot_archive=self.snapshot)
        self.unit.write_text(self.service_unit(self.previous_worker))
        self.unit_hash=update.digest(self.unit.read_bytes());self.env_hash=update.digest(self.env.read_bytes())
        self.old_receipt={'source':self.previous_worker,'unitSha256':self.unit_hash,'selectedEnvironmentSha256':self.env_hash,'serviceStable':True}
        (self.old_release/'worker-install-v2.json').write_text(json.dumps(self.old_receipt))
        self.manifest={'entries':[{'path':'package.json','type':'file','mode':0o644}]}
        canonical=lambda value:json.dumps(value,sort_keys=True,separators=(',',':')).encode()
        self.fmt=SimpleNamespace(MAX_ARCHIVE=1024,canonical=canonical,digest=update.digest,extract_archive=self.extract,inspect_archive=lambda *_:self.manifest)
    def service_unit(self,source):return 'WorkingDirectory='+str(self.app/'releases'/source)+'\nRestart=on-failure\n'
    def protected(self,path,regular=False):
        check(Path(path).is_relative_to(self.root) and Path(path).exists() and not Path(path).is_symlink(),'unsafe fixture path')
        if regular:check(Path(path).is_file(),'fixture regular file required')
    def deployment(self,source,build):
        check(source==self.web and build==(self.old_build if source==self.previous_web else self.new_build),'web identity differs')
        if source==self.source and self.fault=='final-web' and self.report['MainPID']=='456':raise ValueError('web changed after start')
        return [source,build]
    def write_new(self,path,raw,mode):
        if self.fault in ('install-receipt','activation-receipt') and Path(path).name==('worker-install-v2.json' if self.fault=='install-receipt' else 'activated.json'):
            raise OSError('fictional receipt persistence failure')
        fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY,mode)
        with os.fdopen(fd,'wb') as stream:stream.write(raw)
    def snapshot(self,source,target,expected,limit):
        raw=Path(source).read_bytes();check(update.digest(raw)==expected,'archive digest differs');self.events.append('authenticate-archive');Path(target).write_bytes(raw)
    def extract(self,archive,destination,*_):
        self.events.append('extract');(Path(destination)/'package.json').write_text('fictional package')
        if self.fault=='prepare-web-stopped':self.web_active=False
        return self.manifest
    def health_connection(self,host,port,timeout):
        check((host,port,timeout)==('127.0.0.1',3000,8),'unexpected health target')
        def request(method,path,headers):
            check((method,path,headers)==('GET','/health',{'Connection':'close'}),'unexpected health request')
            self.events.append('web-health')
        return SimpleNamespace(request=request,getresponse=lambda:SimpleNamespace(status=self.health_status,read=lambda limit:self.health_body[:limit]),close=lambda:None)
    def command(self,argv):
        self.events.append(list(argv))
        if argv==[str(self.node),'--version']:return SimpleNamespace(stdout='v22.23.3\n')
        if argv==['/usr/bin/systemctl','is-active','--quiet','aihr']:check(self.web_active,'web service inactive')
        if 'daemon-reload' in argv:
            if self.fault=='reload' and not self.used_fault:self.used_fault=True;raise OSError('fictional reload failure')
            quarantine='SendSIGKILL=no' in self.unit.read_text()
            self.report.update(Restart='no' if quarantine else 'on-failure',SendSIGKILL='no' if quarantine else 'yes',NeedDaemonReload='no')
        elif 'kill' in argv:self.report.update(MainPID='0',ActiveState='inactive',SubState='dead')
        elif 'start' in argv:
            self.report.update(MainPID='456',ActiveState='active',SubState='running')
            if self.fault in ('start','start-disable'):raise OSError('fictional start command failure after launch')
            if self.fault=='restart':self.report['NRestarts']='1'
        elif 'disable' in argv:
            if self.fault=='start-disable':raise OSError('fictional disable failure')
            self.report['UnitFileState']='disabled'
        elif 'stop' in argv:
            check(self.report['SendSIGKILL']=='no' and self.report['Restart']=='no','timed stop lacks protection')
            self.report.update(MainPID='0',ActiveState='inactive',SubState='dead')
        return SimpleNamespace(stdout='',returncode=0)
    def args(self,phase,overrides=None):
        values={'previous-web-source':self.previous_web,'previous-web-build':self.old_build,'previous-worker-source':self.previous_worker,'source':self.source,'build-id':self.new_build,'archive':str(self.archive),'archive-sha256':update.digest(self.archive.read_bytes()),'lock-sha256':'a'*64,'package-sha256':'b'*64,'unit-sha256':self.unit_hash,'worker-env-sha256':self.env_hash}
        values.update(overrides or {})
        return [phase,*[part for key,value in values.items() for part in ('--'+key,value)]]
    def invoke(self,phase,overrides=None):
        original_fstat=os.fstat
        def root_lock(fd):
            info=original_fstat(fd);return SimpleNamespace(st_mode=info.st_mode,st_uid=0,st_nlink=info.st_nlink)
        with ExitStack() as stack:
            stack.enter_context(patch.object(update.os,'geteuid',return_value=0))
            stack.enter_context(patch.object(update.os,'fstat',side_effect=root_lock))
            stack.enter_context(patch.object(update,'properties',side_effect=lambda _:dict(self.report)))
            stack.enter_context(patch.object(update,'HTTPConnection',side_effect=self.health_connection))
            stack.enter_context(patch.object(update,'validate_process',side_effect=lambda _,report,source:int(report['MainPID'])))
            stack.enter_context(patch.object(update.time,'sleep'))
            for item in self.extra_patches():stack.enter_context(item)
            update.upgrade(self.args(phase,overrides),self.fmt,self.base)
    def extra_patches(self):return []
    @property
    def operation(self):return self.app/'upgrades'/self.source

class WorkerUpgradeFlowTests(unittest.TestCase):
    def test_complete_drain_and_activation_preserves_old_release_and_private_environment(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=UpgradeFlowFixture(Path(tmp));before=f.env.read_bytes();f.invoke('drain')
            term=next(i for i,event in enumerate(f.events) if isinstance(event,list) and 'kill' in event)
            self.assertLess(f.events.index('authenticate-archive'),term);self.assertLess(f.events.index('extract'),term)
            self.assertEqual(f.unit.read_text(),f.service_unit(f.previous_worker));f.web=f.source;f.invoke('activate')
            self.assertTrue(f.old_release.is_dir());self.assertEqual(f.env.read_bytes(),before)
            record=json.loads((f.operation/'activated.json').read_text());self.assertEqual(record['workerPid'],456);self.assertFalse(record['journeyVerified'])
            self.assertEqual(f.unit.read_text(),f.service_unit(f.source));self.assertEqual(f.report['ActiveState'],'active')
    def test_different_previous_web_and_worker_sources_are_bound_independently(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=UpgradeFlowFixture(Path(tmp),previous_web='3'*40);before=f.env.read_bytes();f.invoke('drain')
            drained=json.loads((f.operation/'drained.json').read_text())
            self.assertEqual(drained['identity']['previous_web_source'],'3'*40)
            self.assertEqual(drained['identity']['previous_worker_source'],'1'*40)
            self.assertEqual(drained['identity']['previous_web_build'],f.old_build)
            self.assertEqual(f.unit.read_text(),f.service_unit(f.previous_worker))
            f.web=f.source;f.invoke('activate')
            accepted=json.loads((f.operation/'activated.json').read_text())
            self.assertEqual(accepted['previousWebSource'],'3'*40)
            self.assertEqual(accepted['previousWebBuildId'],f.old_build)
            self.assertEqual(accepted['previousWorkerSource'],'1'*40)
            self.assertEqual(accepted['source'],f.source);self.assertEqual(accepted['webBuildId'],f.new_build)
            self.assertTrue(f.old_release.is_dir());self.assertEqual(f.env.read_bytes(),before)
    def test_wrong_independent_previous_web_or_worker_identity_refuses_before_drain(self):
        for overrides in [{'previous-web-source':'1'*40},{'previous-web-build':'wrong-build'},{'previous-worker-source':'3'*40}]:
            with self.subTest(overrides=overrides),tempfile.TemporaryDirectory() as tmp:
                f=UpgradeFlowFixture(Path(tmp),previous_web='3'*40)
                with self.assertRaises(ValueError):f.invoke('drain',overrides)
                self.assertFalse(f.operation.exists())
                self.assertFalse(any(isinstance(event,list) and 'kill' in event for event in f.events))
                self.assertEqual(f.unit.read_text(),f.service_unit(f.previous_worker))
    def test_matching_deployment_records_do_not_allow_drain_with_unhealthy_web(self):
        for defect in ['stopped','unhealthy','wrong-body','oversize','changes-after-extract']:
            with self.subTest(defect=defect),tempfile.TemporaryDirectory() as tmp:
                f=UpgradeFlowFixture(Path(tmp),previous_web='3'*40)
                if defect=='stopped':f.web_active=False
                if defect=='unhealthy':f.health_status=503
                if defect=='wrong-body':f.health_body=b'{"status":"unhealthy"}'
                if defect=='oversize':f.health_body=b' '*4097
                if defect=='changes-after-extract':f.fault='prepare-web-stopped'
                with self.assertRaises(ValueError):f.invoke('drain')
                self.assertFalse(any(isinstance(event,list) and 'kill' in event for event in f.events))
                self.assertEqual(f.unit.read_text(),f.service_unit(f.previous_worker));self.assertEqual(f.report['ActiveState'],'active')
    def test_bad_archive_refuses_before_signalling_or_unit_mutation(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=UpgradeFlowFixture(Path(tmp));f.base.snapshot_archive=lambda *_:check(False,'archive digest differs')
            with self.assertRaisesRegex(ValueError,'archive digest'):f.invoke('drain')
            self.assertFalse(any(isinstance(event,list) and 'kill' in event for event in f.events));self.assertEqual(f.unit.read_text(),f.service_unit(f.previous_worker))
    def test_previous_receipt_and_environment_mismatch_refuse_before_drain(self):
        for defect in ['receipt','environment']:
            with self.subTest(defect=defect),tempfile.TemporaryDirectory() as tmp:
                f=UpgradeFlowFixture(Path(tmp))
                if defect=='receipt':(f.old_release/'worker-install-v2.json').write_text('{}')
                else:f.env.write_text('changed')
                with self.assertRaises(ValueError):f.invoke('drain')
                self.assertFalse(f.operation.exists());self.assertFalse(any(isinstance(event,list) and 'kill' in event for event in f.events))
    def test_activate_refuses_wrong_web_or_drain_record_before_unit_change(self):
        for defect in ['web','web-health','build','drain-web','drain-worker']:
            with self.subTest(defect=defect),tempfile.TemporaryDirectory() as tmp:
                f=UpgradeFlowFixture(Path(tmp));f.invoke('drain')
                if defect=='web-health':f.web=f.source;f.health_status=503
                elif defect!='web':
                    key={'build':'build_id','drain-web':'previous_web_source','drain-worker':'previous_worker_source'}[defect]
                    record=json.loads((f.operation/'drained.json').read_text());record['identity'][key]='foreign';(f.operation/'drained.json').chmod(0o600);(f.operation/'drained.json').write_text(json.dumps(record));(f.operation/'drained.json').chmod(0o400);f.web=f.source
                with self.assertRaises(ValueError):f.invoke('activate')
                self.assertEqual(f.unit.read_text(),f.service_unit(f.previous_worker));self.assertFalse((f.operation/'activated.json').exists())
    def test_failures_after_replacement_quarantine_without_rollback_or_acceptance(self):
        for fault in ['reload','start','restart','final-web','install-receipt','activation-receipt']:
            with self.subTest(fault=fault),tempfile.TemporaryDirectory() as tmp:
                f=UpgradeFlowFixture(Path(tmp));f.invoke('drain');f.web=f.source;f.fault=fault
                with self.assertRaisesRegex(RuntimeError,'activation failed'):f.invoke('activate')
                self.assertTrue(f.old_release.is_dir());self.assertTrue((f.app/'releases'/f.source).is_dir())
                self.assertTrue((f.operation/'activation-failed.json').exists());self.assertFalse((f.operation/'activated.json').exists())
                observed=json.loads((f.operation/'activation-failure-observation.json').read_text());self.assertTrue(observed['stopped']);self.assertTrue(observed['disabled']);self.assertFalse(observed['accepted'])
                self.assertIn('Restart=no',f.unit.read_text());self.assertIn('SendSIGKILL=no',f.unit.read_text())
                with self.assertRaises(ValueError):f.invoke('activate')
    def test_disable_failure_still_requests_protected_stop_and_reports_both_observations(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=UpgradeFlowFixture(Path(tmp));f.invoke('drain');f.web=f.source;f.fault='start-disable'
            with self.assertRaisesRegex(RuntimeError,'activation failed'):f.invoke('activate')
            observed=json.loads((f.operation/'activation-failure-observation.json').read_text())
            self.assertTrue(observed['stopped']);self.assertFalse(observed['disabled']);self.assertTrue(observed['disableRequestFailed'])
            self.assertTrue(any(isinstance(event,list) and 'stop' in event for event in f.events));self.assertEqual(f.report['SendSIGKILL'],'no')
    def test_quarantine_refuses_foreign_unit_without_signalling_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=UpgradeFlowFixture(Path(tmp));f.operation.mkdir(parents=True);f.unit.write_text('foreign unit')
            observed=update.quiesce_failed_activation(f.base,f.operation,f.source)
            self.assertFalse(observed['stopped']);self.assertTrue(observed['quiescenceUnconfirmed']);self.assertEqual(f.events,[])
            self.assertEqual(f.unit.read_text(),'foreign unit')
    def test_missing_receipt_refuses_drain_and_activate(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=UpgradeFlowFixture(Path(tmp));(f.old_release/'worker-install-v2.json').unlink()
            with self.assertRaises(ValueError):f.invoke('drain')
            self.assertFalse(f.operation.exists());self.assertFalse(any(isinstance(event,list) and 'kill' in event for event in f.events))
        with tempfile.TemporaryDirectory() as tmp:
            f=UpgradeFlowFixture(Path(tmp));f.invoke('drain');(f.old_release/'worker-install-v2.json').unlink();f.web=f.source
            with self.assertRaises(ValueError):f.invoke('activate')
            self.assertEqual(f.unit.read_text(),f.service_unit(f.previous_worker));self.assertFalse((f.app/'releases'/f.source).exists())
    def test_failed_quarantine_reload_never_arms_an_unprotected_stop(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=UpgradeFlowFixture(Path(tmp));f.operation.mkdir(parents=True);f.unit.write_text(f.service_unit(f.source));f.fault='reload'
            observed=update.quiesce_failed_activation(f.base,f.operation,f.source)
            self.assertFalse(observed['stopped']);self.assertTrue(observed['quiescenceUnconfirmed'])
            self.assertFalse(any(isinstance(event,list) and 'stop' in event for event in f.events))

PROCESS_FIELDS=('User','Group','WorkingDirectory','FragmentPath','EnvironmentFiles')

class AdoptFlowFixture(UpgradeFlowFixture):
    """A prior worker from an earlier ad-hoc procedure: legacy unit bytes, no receipt, cleanly stopped."""
    def __init__(self,root):
        super().__init__(root);self.web=self.source;self.uid=4242;self.live=[];self.cgroup=''
        (self.old_release/'worker-install-v2.json').unlink()
        self.unit.write_text(self.legacy_unit());self.observed=update.digest(self.unit.read_bytes())
        self.report.update(MainPID='0',ActiveState='inactive',SubState='dead',User='fictional',Group='fictional',
            WorkingDirectory=str(self.old_release),FragmentPath=str(self.unit),EnvironmentFiles=str(self.env)+' (ignore_errors=no)',
            **{key:'' for key in update.OVERRIDE_KEYS})
    def legacy_unit(self):return 'WorkingDirectory='+str(self.old_release)+'\nEnvironment=NODE_ENV=production\nRestart=on-failure\n'
    def command(self,argv):
        if 'show' in argv:
            self.events.append(list(argv));return SimpleNamespace(stdout='ControlGroup='+self.cgroup+'\nExecMainPID=123\nExecMainExitTimestamp=fictional\nInactiveEnterTimestamp=fictional\n',returncode=0)
        return super().command(argv)
    def extract(self,archive,destination,*rest):
        manifest=super().extract(archive,destination,*rest)
        if self.fault=='prepare-prior-started':self.report.update(MainPID='789',ActiveState='active',SubState='running')
        if self.fault=='prepare-prior-process':self.live=[789]
        if self.fault=='prepare-unit-changed':self.unit.write_text('changed unit')
        if self.fault=='prepare-env-changed':self.env.write_text('changed')
        return manifest
    def args(self,phase,overrides=None):
        values={'previous-worker-source':self.previous_worker,'source':self.source,'build-id':self.new_build,'archive':str(self.archive),'archive-sha256':update.digest(self.archive.read_bytes()),'lock-sha256':'a'*64,'package-sha256':'b'*64,'observed-unit-sha256':self.observed,'worker-env-sha256':self.env_hash}
        values.update(overrides or {})
        return [phase,*[part for key,value in values.items() if value is not None for part in ('--'+key,value)]]
    def extra_patches(self):
        return [patch.object(update.pwd,'getpwnam',return_value=SimpleNamespace(pw_uid=self.uid)),
                patch.object(update,'unit_or_identity_processes',side_effect=lambda uid:(check(uid==self.uid,'scanned wrong identity'),list(self.live))[1])]
    def mutations(self):return [event for event in self.events if isinstance(event,list) and any(word in event for word in ('kill','stop','start','disable','daemon-reload'))]

class AdoptStoppedFlowTests(unittest.TestCase):
    def test_adopts_cleanly_stopped_prior_with_current_template_and_fresh_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=AdoptFlowFixture(Path(tmp));before=f.env.read_bytes();legacy=f.unit.read_bytes();f.invoke('adopt-stopped')
            commands=f.mutations()
            self.assertEqual(commands,[['/usr/bin/systemctl','daemon-reload'],['/usr/bin/systemctl','start','aihr-bank-import.service']])
            self.assertEqual(f.unit.read_text(),f.service_unit(f.source));self.assertEqual(f.report['ActiveState'],'active')
            self.assertTrue(f.old_release.is_dir());self.assertEqual(f.env.read_bytes(),before)
            self.assertEqual((f.operation/'prior-unit.service').read_bytes(),legacy)
            observed=json.loads((f.operation/'stopped-prior.json').read_text())
            self.assertEqual(observed['prior']['state'],'stopped');self.assertFalse(observed['prior']['forcedKill']);self.assertEqual(observed['prior']['livePids'],[])
            self.assertEqual(observed['prior']['properties']['Result'],'success');self.assertEqual(observed['prior']['runtime']['ControlGroup'],'')
            self.assertEqual(observed['identity']['observed_unit_sha256'],f.observed);self.assertNotIn('unit_sha256',observed['identity'])
            receipt=json.loads((f.app/'releases'/f.source/'worker-install-v2.json').read_text())
            self.assertEqual(receipt,json.loads((f.operation/'activated.json').read_text()))
            self.assertEqual(receipt['mode'],'adopt-stopped');self.assertEqual(receipt['previousUnitSha256'],f.observed)
            self.assertEqual(receipt['previousWorkerSource'],f.previous_worker);self.assertEqual(receipt['unitSha256'],update.digest(f.service_unit(f.source).encode()))
            self.assertEqual(receipt['selectedEnvironmentSha256'],f.env_hash);self.assertEqual(receipt['workerPid'],456)
            self.assertTrue(receipt['serviceStable']);self.assertFalse(receipt['journeyVerified'])
            self.assertEqual(receipt['priorObservationSha256'],update.digest(f.fmt.canonical(observed['prior'])))
            # The fresh receipt is exactly what a later managed drain validates.
            self.assertEqual(receipt['source'],f.source);self.assertNotIn('previousWebSource',receipt)
    def test_adopts_when_systemd_omits_unset_override_properties(self):
        # systemd 255 prints no line at all for an unset ExecStartPre/ExecStop/... property (staging, 11 Nov 2026).
        with tempfile.TemporaryDirectory() as tmp:
            f=AdoptFlowFixture(Path(tmp))
            for key in ('ExecStartPre','ExecStartPost','ExecStop','ExecStopPost','ExecCondition'):f.report.pop(key,None)
            f.invoke('adopt-stopped');self.assertEqual(f.report['ActiveState'],'active')
            self.assertEqual(f.unit.read_text(),f.service_unit(f.source))
    def test_refuses_a_set_override_even_when_others_are_omitted(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=AdoptFlowFixture(Path(tmp));legacy=f.unit.read_bytes()
            for key in ('ExecStartPost','ExecStop','ExecStopPost','ExecCondition'):f.report.pop(key,None)
            f.report['ExecStartPre']='{ path=/bin/sh ; argv[]=/bin/sh -c fictional }'
            with self.assertRaises(ValueError):f.invoke('adopt-stopped')
            self.assertFalse(f.operation.exists());self.assert_refused_without_change(f,legacy)
    def assert_refused_without_change(self,f,legacy):
        self.assertEqual(f.unit.read_bytes(),legacy);self.assertEqual(f.mutations(),[])
        self.assertFalse((f.app/'releases'/f.source).exists())
    def test_refuses_active_failed_restarting_or_live_prior_before_any_change(self):
        defects={'active':{'MainPID':'123','ActiveState':'active','SubState':'running'},'activating':{'ActiveState':'activating','SubState':'start'},
                 'failed':{'ActiveState':'failed','SubState':'failed','Result':'exit-code','ExecMainStatus':'1'},
                 'nonzero-exit':{'ExecMainStatus':'1'},'unsuccessful-result':{'Result':'signal'},'main-pid':{'MainPID':'123'},
                 'reload-pending':{'NeedDaemonReload':'yes'},'disabled':{'UnitFileState':'disabled'},'drop-in':{'DropInPaths':'/etc/x.conf'},
                 'other-directory':{'WorkingDirectory':'/elsewhere'},'live-process':'live','control-group':'cgroup','receipt':'receipt','identity':'identity'}
        for defect,change in defects.items():
            with self.subTest(defect=defect),tempfile.TemporaryDirectory() as tmp:
                f=AdoptFlowFixture(Path(tmp));legacy=f.unit.read_bytes()
                if change=='live':f.live=[777]
                elif change=='cgroup':f.cgroup='/system.slice/aihr-bank-import.service'
                elif change=='receipt':(f.old_release/'worker-install-v2.json').write_text(json.dumps(f.old_receipt))
                elif change=='identity':f.extra_patches=lambda:[patch.object(update.pwd,'getpwnam',side_effect=KeyError('fictional'))]
                else:f.report.update(change)
                with self.assertRaises(ValueError):f.invoke('adopt-stopped')
                self.assertFalse(f.operation.exists());self.assert_refused_without_change(f,legacy)
                if change=='receipt':self.assertTrue((f.old_release/'worker-install-v2.json').exists())
    def test_refuses_unit_or_environment_hash_mismatch(self):
        for defect in ['observed-pin','unit-bytes','env-pin','env-bytes']:
            with self.subTest(defect=defect),tempfile.TemporaryDirectory() as tmp:
                f=AdoptFlowFixture(Path(tmp));overrides={}
                if defect=='observed-pin':overrides['observed-unit-sha256']='c'*64
                if defect=='unit-bytes':f.unit.write_text(f.service_unit(f.previous_worker))
                if defect=='env-pin':overrides['worker-env-sha256']='d'*64
                if defect=='env-bytes':f.env.write_text('changed')
                legacy=f.unit.read_bytes()
                with self.assertRaisesRegex(ValueError,'unit differs|environment differs'):f.invoke('adopt-stopped',overrides)
                self.assertFalse(f.operation.exists());self.assert_refused_without_change(f,legacy)
    def test_refuses_unhealthy_or_different_current_web(self):
        for defect in ['stopped','unhealthy','wrong-body','previous-web','wrong-build','changes-after-extract']:
            with self.subTest(defect=defect),tempfile.TemporaryDirectory() as tmp:
                f=AdoptFlowFixture(Path(tmp));legacy=f.unit.read_bytes();overrides={}
                if defect=='stopped':f.web_active=False
                if defect=='unhealthy':f.health_status=503
                if defect=='wrong-body':f.health_body=b'{"status":"degraded"}'
                if defect=='previous-web':f.web=f.previous_worker
                if defect=='wrong-build':overrides['build-id']='other-build'
                if defect=='changes-after-extract':f.fault='prepare-web-stopped'
                with self.assertRaises(ValueError):f.invoke('adopt-stopped',overrides)
                self.assertEqual(f.unit.read_bytes(),legacy);self.assertEqual(f.mutations(),[]);self.assertFalse((f.operation/'activated.json').exists())
    def test_rechecks_pinned_prior_immediately_before_replacement(self):
        for fault in ['prepare-prior-started','prepare-prior-process','prepare-unit-changed','prepare-env-changed']:
            with self.subTest(fault=fault),tempfile.TemporaryDirectory() as tmp:
                f=AdoptFlowFixture(Path(tmp));f.fault=fault;legacy=f.unit.read_bytes()
                with self.assertRaises(ValueError):f.invoke('adopt-stopped')
                if fault!='prepare-unit-changed':self.assertEqual(f.unit.read_bytes(),legacy)
                self.assertEqual(f.mutations(),[]);self.assertTrue((f.operation/'stopped-prior.json').exists())
                self.assertFalse((f.operation/'activated.json').exists());self.assertTrue(f.old_release.is_dir())
    def test_argument_surface_keeps_adopt_and_managed_pins_separate(self):
        cases=[('adopt-stopped',{'observed-unit-sha256':None}),('adopt-stopped',{'unit-sha256':'e'*64}),('adopt-stopped',{'previous-web-source':'1'*40}),
               ('adopt-stopped',{'previous-web-build':'old-build'}),('adopt-stopped',{'source':'1'*40}),('adopt-stopped',{'observed-unit-sha256':'short'})]
        for phase,overrides in cases:
            with self.subTest(overrides=overrides),tempfile.TemporaryDirectory() as tmp:
                f=AdoptFlowFixture(Path(tmp));legacy=f.unit.read_bytes()
                with self.assertRaises(ValueError):f.invoke(phase,overrides)
                self.assertFalse((f.app/'upgrades').exists());self.assert_refused_without_change(f,legacy)
        with tempfile.TemporaryDirectory() as tmp:
            f=UpgradeFlowFixture(Path(tmp))
            with self.assertRaisesRegex(ValueError,'not part of drain'):f.invoke('drain',{'observed-unit-sha256':'e'*64})
            self.assertFalse(f.operation.exists());self.assertFalse(any(isinstance(event,list) and 'kill' in event for event in f.events))
    def test_existing_attempt_refuses_a_second_adoption(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=AdoptFlowFixture(Path(tmp));f.operation.mkdir(parents=True);legacy=f.unit.read_bytes()
            with self.assertRaisesRegex(ValueError,'existing update attempt'):f.invoke('adopt-stopped')
            self.assert_refused_without_change(f,legacy)
    def test_failures_after_replacement_quarantine_without_restoring_prior(self):
        for fault in ['reload','start','restart','final-web','install-receipt','activation-receipt']:
            with self.subTest(fault=fault),tempfile.TemporaryDirectory() as tmp:
                f=AdoptFlowFixture(Path(tmp));legacy=f.unit.read_bytes();f.fault=fault
                with self.assertRaisesRegex(RuntimeError,'activation failed'):f.invoke('adopt-stopped')
                self.assertTrue(f.old_release.is_dir());self.assertTrue((f.app/'releases'/f.source).is_dir())
                self.assertEqual((f.operation/'prior-unit.service').read_bytes(),legacy);self.assertTrue((f.operation/'stopped-prior.json').exists())
                self.assertTrue((f.operation/'activation-failed.json').exists());self.assertFalse((f.operation/'activated.json').exists())
                observed=json.loads((f.operation/'activation-failure-observation.json').read_text())
                self.assertTrue(observed['stopped']);self.assertTrue(observed['disabled']);self.assertFalse(observed['accepted']);self.assertFalse(observed['forcedKill'])
                self.assertIn('Restart=no',f.unit.read_text());self.assertIn('SendSIGKILL=no',f.unit.read_text());self.assertNotEqual(f.unit.read_bytes(),legacy)
                self.assertFalse(any(isinstance(event,list) and 'kill' in event for event in f.events))
                with self.assertRaises(ValueError):f.invoke('adopt-stopped')

class ProcessScanTests(unittest.TestCase):
    def scan(self,proc,uid=4242):
        with patch.object(update,'Path',side_effect=lambda value:proc if value=='/proc' else Path(value)):return update.unit_or_identity_processes(uid)
    def write(self,proc,pid,uid,cgroup):
        entry=proc/str(pid);entry.mkdir(parents=True)
        (entry/'status').write_bytes(b'Name:\tfictional\nUid:\t'+'\t'.join(uid).encode()+b'\n');(entry/'cgroup').write_bytes(cgroup)
    def test_finds_identity_and_unit_cgroup_processes_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc=Path(tmp);(proc/'self').mkdir()
            self.write(proc,10,['0','0','0','0'],b'0::/system.slice/aihr.service\n')
            self.write(proc,11,['1000','4242','1000','1000'],b'0::/user.slice\n')
            self.write(proc,12,['0','0','0','0'],b'0::/system.slice/aihr-bank-import.service\n')
            self.write(proc,13,['0','0','0','0'],b'1:name=systemd:/system.slice/aihr-bank-import.service/child\n')
            self.write(proc,14,['0','0','0','0'],b'0::/system.slice/aihr-bank-import.service-other.scope\n')
            (proc/'15').mkdir()
            self.assertEqual(self.scan(proc),[11,12,13])
            self.assertEqual(self.scan(proc,uid=0),[10,12,13,14])
    def test_refuses_unreadable_process_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc=Path(tmp);entry=proc/'20';entry.mkdir();(entry/'status').write_bytes(b'Name:\tfictional\n');(entry/'cgroup').write_bytes(b'0::/\n')
            with self.assertRaisesRegex(ValueError,'unreadable'):self.scan(proc)

# Production first activation (production runbook section 6). Simulated customer layout only; fictional values.
def load_module(name,path):
    module_spec=importlib.util.spec_from_file_location(name,ROOT/path);module=importlib.util.module_from_spec(module_spec);module_spec.loader.exec_module(module);return module
install=load_module('worker_installer','deploy/systemd/bank_import_worker_installer_v2.py')
fmt_module=load_module('worker_format','deploy/systemd/bank_import_worker_format.py')
production=load_module('worker_production','deploy/systemd/bank_import_worker_production_v1.py')
APP_SECRET='fictional-app-secret-7Qx'
OWNER_SECRET='fictional-owner-secret-9Lm'
PRIOR=('7fe8f862'+'0'*32,'b7c0393a'+'0'*32)
MUTATING=('daemon-reload','start','enable','disable','stop','kill')

class RootOwned:
    def __init__(self,info):self._info=info
    def __getattr__(self,name):return 0 if name=='st_uid' else getattr(self._info,name)

class ProductionFixture:
    """Customer layout: existing aihr-import identity and protected env, receipt-less prior releases, no worker unit,
    a remote TLS database. Real temporary files; deterministic systemd/procfs/psql/identity adapters only."""
    def __init__(self,root,omit_empty=False):
        self.root=root;self.events=[];self.fault=None;self.used_fault=False;self.omit_empty=omit_empty
        self.source='2'*40;self.build='Pbuild_fictional-1';self.uid=998;self.gid=998;self.live=[];self.port=3000
        self.external=set() # Production paths outside the fixture root, modelled as root-protected regular files.
        self.health_status=200;self.health_body=b'{"status":"ok"}';self.stdout='';self.stderr=''
        self.web_app=root/'opt-ai-hr';(self.web_app/'.next').mkdir(parents=True);(self.web_app/'.next'/'BUILD_ID').write_text(self.build+'\n')
        self.web={'ActiveState':'active','SubState':'running','MainPID':'321','User':'aihr','WorkingDirectory':str(self.web_app)}
        self.app=root/'opt-aihr-import';(self.app/'releases').mkdir(parents=True)
        for prior in PRIOR:(self.app/'releases'/prior).mkdir();(self.app/'releases'/prior/'package.json').write_text('prior '+prior)
        self.unit_dirs=[root/'etc-systemd',root/'run-systemd',root/'lib-systemd']
        for directory in self.unit_dirs:directory.mkdir()
        (self.unit_dirs[0]/'multi-user.target.wants').mkdir();(self.unit_dirs[0]/'aihr.service').write_text('fictional web unit')
        self.unit=self.unit_dirs[0]/'aihr-bank-import.service'
        self.ca=root/'certs'/'db-ca.pem';self.ca.parent.mkdir();self.ca.write_text('fictional CA')
        self.env=root/'etc-aihr'/'import-worker.env';self.env.parent.mkdir()
        self.values={'AUDIT_HASH_CHAIN_ENABLED':'true','NODE_EXTRA_CA_CERTS':str(self.ca),'PGSSLROOTCERT':str(self.ca),
            'DATABASE_URL':'postgresql://ai_hr_app:'+APP_SECRET+'@db.internal.invalid:5432/ai_hr?sslmode=verify-full',
            'MIGRATION_DATABASE_URL':'postgresql://ai_hr_owner:'+OWNER_SECRET+'@db.internal.invalid:5432/ai_hr?sslmode=verify-full'}
        self.write_env(self.render(self.values))
        self.node=root/'node22';self.node.write_text('fictional')
        self.proc=root/'proc';self.proc.mkdir()
        self.archive=root/'worker-package.zip';self.archive.write_bytes(b'authenticated fictional worker archive')
        self.manifest_path=root/'release-manifest.json'
        self.write_manifest({'schemaVersion':1,'commit':self.source,'buildId':self.build,'platform':'linux','architecture':'x86_64'})
        self.worker_manifest={'entries':[{'path':'package.json','type':'file','mode':0o644},{'path':'scripts','type':'directory'},{'path':'scripts/bank-import-runner.ts','type':'file','mode':0o644}]}
        self.fmt=SimpleNamespace(MAX_ARCHIVE=1024,canonical=fmt_module.canonical,digest=fmt_module.digest,extract_archive=self.extract,inspect_archive=lambda *_:self.worker_manifest)
        self.state={'LoadState':'not-found','ActiveState':'inactive','SubState':'dead','MainPID':'0','NRestarts':'0','Result':'success','ExecMainStatus':'0'}
        self.identity=SimpleNamespace(pw_name='aihr-import',pw_uid=self.uid,pw_gid=self.gid,pw_shell='/usr/sbin/nologin',pw_dir=str(root/'nonexistent'))
        self.accounts=[self.identity,SimpleNamespace(pw_name='aihr',pw_uid=997,pw_gid=997,pw_shell='/usr/sbin/nologin',pw_dir='/nonexistent')]
        self.groups=[SimpleNamespace(gr_name='aihr-import',gr_gid=self.gid,gr_mem=[]),SimpleNamespace(gr_name='aihr',gr_gid=997,gr_mem=[])]
        self.base=SimpleNamespace(**{name:getattr(install,name) for name in ('check','service_unit','validate_service','service_properties','snapshot_archive','read_bounded','BASE_ENV','ENV_KEYS','USER')},
            ROOT=self.app,NODE=self.node,UNIT=self.unit,ENV=self.env,command=self.command,root_protected=self.protected,write_new=self.write_new,install_lock_directory=lambda:root)
    @staticmethod
    def render(values):
        # Production's file predates the managed installer: mixed unquoted and double-quoted values, a comment.
        return '# fictional protected worker environment\n'+''.join(key+'='+('"'+value+'"' if index%2 else value)+'\n' for index,(key,value) in enumerate(sorted(values.items())))
    def write_env(self,text,mode=0o600,repin=True):
        if self.env.exists():self.env.chmod(0o600)
        self.env.write_text(text);self.env.chmod(mode)
        if repin:self.env_hash=update.digest(self.env.read_bytes())
    def write_manifest(self,manifest):
        self.manifest_path.write_text(json.dumps(manifest));self.manifest_hash=update.digest(self.manifest_path.read_bytes())
    def protected(self,path,regular=False):
        path=Path(path)
        if path in self.external:return
        check(path.is_relative_to(self.root) and path.exists() and not path.is_symlink(),'unsafe fixture path')
        if regular:check(path.is_file(),'fixture regular file required')
    def write_new(self,path,raw,mode):
        if self.fault=='receipt' and Path(path).name=='worker-install-v2.json':raise OSError('fictional receipt persistence failure')
        install.write_new(path,raw,mode)
    def extract(self,archive,destination,*_):
        self.events.append('extract');destination=Path(destination)
        (destination/'package.json').write_text('fictional package');(destination/'scripts').mkdir();(destination/'scripts'/'bank-import-runner.ts').write_text('fictional runner')
        if self.fault=='prepare-web':self.web['MainPID']='654'
        if self.fault=='prepare-process':self.live=[777]
        if self.fault=='prepare-unit':self.unit.write_text('foreign unit')
        if self.fault=='prepare-env':self.write_env(self.render({**self.values,'AUDIT_HASH_CHAIN_ENABLED':'false'}),repin=False)
        return self.worker_manifest
    def health_connection(self,host,port,timeout):
        check((host,timeout)==('127.0.0.1',8),'unexpected health target')
        def request(method,path,headers):
            if port!=self.port:raise ConnectionRefusedError(111,'fictional connection refused')
            check((method,path,headers)==('GET','/health',{'Connection':'close'}),'unexpected health request');self.events.append('web-health')
        return SimpleNamespace(request=request,getresponse=lambda:SimpleNamespace(status=self.health_status,read=lambda limit:self.health_body[:limit]),close=lambda:None)
    def show(self,data,fields):
        # systemd 255 prints no line at all for an unset property; older releases print `Key=`.
        return '\n'.join(field+'='+data.get(field,'') for field in fields if data.get(field,'')!='' or not self.omit_empty)+'\n'
    def load(self,text):
        lines=text.splitlines();get=lambda key:next((line.split('=',1)[1] for line in lines if line.startswith(key+'=')),'')
        self.state.update(LoadState='loaded',User=get('User'),Group=get('Group'),WorkingDirectory=get('WorkingDirectory').replace('/opt/aihr-import',str(self.app)),
            FragmentPath=str(install.UNIT),EnvironmentFiles=get('EnvironmentFile')+' (ignore_errors=no)',
            Environment=' '.join(line.split('=',1)[1] for line in lines if line.startswith('Environment=')),ExecStart=get('ExecStart'),
            Restart=get('Restart'),SendSIGKILL='no' if get('SendSIGKILL')=='no' else 'yes',NeedDaemonReload='no',UnitFileState=self.state.get('UnitFileState') or 'disabled')
        if self.fault=='drop-in-after-reload':self.state['DropInPaths']='/etc/systemd/system/service.d/fictional.conf'
    def launch(self):
        self.state.update(ActiveState='active',SubState='running',MainPID='456')
        process=self.proc/'456';process.mkdir(exist_ok=True)
        (process/'status').write_bytes(b'Name:\tnode\nUid:\t'+'\t'.join([str(self.uid)]*4).encode()+b'\n')
        if not (process/'cwd').is_symlink():(process/'cwd').symlink_to(Path(self.state['WorkingDirectory']),target_is_directory=True)
        (process/'cmdline').write_bytes(b'\0'.join([str(self.node).encode(),b'--import',b'tsx',b'scripts/bank-import-runner.ts'])+b'\0')
        values={**self.values,**({'DATABASE_URL':'postgresql://drifted'} if self.fault=='env-drift' else {})}
        if self.fault=='quoted-env':values={key:'"'+value+'"' for key,value in values.items()}
        environment={'PATH':'/usr/bin','NODE_ENV':'production','AIHR_DB_PROCESS_ROLE':'worker','AIHR_DB_POOL_MAX':'2',**values}
        (process/'environ').write_bytes(b''.join((key+'='+value).encode()+b'\0' for key,value in environment.items()))
        if self.fault=='restart':self.state['NRestarts']='1'
        if self.fault=='final-web':self.web['MainPID']='999'
    def command(self,argv,input=None,env=None,allow_failure=False):
        self.events.append(list(argv));out=lambda text='':SimpleNamespace(stdout=text,returncode=0)
        if argv==[str(self.node),'--version']:return out('v22.23.3\n')
        if argv[0]=='/usr/sbin/runuser':
            check(argv[1:4]==['--user','aihr-import','--'] and argv[4]=='/usr/bin/test' and argv[5] in ('-r','-x'),'unexpected identity probe')
            if self.fault=='unreadable' and Path(argv[6])==self.ca:raise ValueError('Worker installation refused: administrator/runtime command failed (credentials suppressed)')
            check(Path(argv[6]) in self.external or Path(argv[6]).exists(),'fixture path absent');return out()
        if argv[0]==production.PSQL:
            check(env['PGPASSFILE']=='/dev/null' and env['PGSSLMODE']=='verify-full' and env['PGSSLROOTCERT']==str(self.ca) and env['PGHOST']=='db.internal.invalid' and env['PGDATABASE']=='ai_hr','unexpected libpq settings')
            check('read_only=on' in env['PGOPTIONS'] and input==production.ROLE_PROOF_SQL,'unexpected role proof')
            owner=env['PGUSER']=='ai_hr_owner'
            return out(json.dumps({'role':env['PGUSER'],'database':'ai_hr','super':False,'bypass':self.fault=='db-bypass' and not owner,'owner':owner!=(self.fault=='db-owner')}))
        if argv[:2]==['/usr/bin/systemctl','show']:
            fields=[item.split('=',1)[1] for item in argv if item.startswith('--property=')]
            return out(self.show(self.web if argv[2]=='aihr.service' else self.state,fields))
        if argv==['/usr/bin/systemctl','daemon-reload']:
            if self.fault=='reload' and not self.used_fault:self.used_fault=True;raise OSError('fictional reload failure')
            if self.unit.exists():self.load(self.unit.read_text())
            return out()
        verb=argv[1]
        if verb=='start':
            self.launch()
            if self.fault=='start':raise OSError('fictional start command failure after launch')
        elif verb=='enable':
            if self.fault=='enable':raise OSError('fictional enable failure')
            self.state['UnitFileState']='enabled'
        elif verb=='disable':self.state['UnitFileState']='disabled'
        elif verb=='stop':
            check(self.state.get('SendSIGKILL')=='no' and self.state.get('Restart')=='no','timed stop lacks protection')
            self.state.update(MainPID='0',ActiveState='inactive',SubState='dead')
        return out()
    def lookup(self,name):
        if name=='aihr-import' and self.identity is not None:return self.identity
        raise KeyError(name)
    def group(self,gid):
        for group in self.groups:
            if group.gr_gid==gid:return group
        raise KeyError(gid)
    def args(self,overrides=None):
        values={'source':self.source,'build-id':self.build,'web-port':str(self.port),'release-manifest':str(self.manifest_path),'release-manifest-sha256':self.manifest_hash,
            'archive':str(self.archive),'archive-sha256':update.digest(self.archive.read_bytes()),'lock-sha256':'a'*64,'package-sha256':'b'*64,
            'worker-env-sha256':self.env_hash,'existing-uid':str(self.uid)}
        values.update(overrides or {})
        return ['production-first-install',*[part for key,value in values.items() if value is not None for part in ('--'+key,value)]]
    def invoke(self,overrides=None):return self.call(self.args(overrides))
    def call(self,argv,extra=()):
        original_fstat=os.fstat;stdout=io.StringIO();stderr=io.StringIO()
        try:
            with ExitStack() as stack:
                stack.enter_context(contextlib.redirect_stdout(stdout));stack.enter_context(contextlib.redirect_stderr(stderr))
                stack.enter_context(patch.object(production.os,'geteuid',return_value=0))
                stack.enter_context(patch.object(production.os,'fstat',side_effect=lambda fd:RootOwned(original_fstat(fd))))
                stack.enter_context(patch.object(install,'command',side_effect=self.command))
                stack.enter_context(patch.object(production,'HTTPConnection',side_effect=self.health_connection))
                stack.enter_context(patch.object(production,'PROC',self.proc))
                stack.enter_context(patch.object(production,'WEB_SOURCE',self.web_app))
                stack.enter_context(patch.object(production,'UNIT_DIRECTORIES',tuple(str(d) for d in self.unit_dirs)))
                stack.enter_context(patch.object(production.pwd,'getpwnam',side_effect=self.lookup))
                stack.enter_context(patch.object(production.pwd,'getpwall',side_effect=lambda:list(self.accounts)))
                stack.enter_context(patch.object(production.grp,'getgrgid',side_effect=self.group))
                stack.enter_context(patch.object(production.grp,'getgrall',side_effect=lambda:list(self.groups)))
                stack.enter_context(patch.object(update,'unit_or_identity_processes',side_effect=lambda uid:(check(uid==self.uid,'scanned wrong identity'),list(self.live))[1]))
                stack.enter_context(patch.object(production.time,'sleep'))
                for item in extra:stack.enter_context(item)
                # The bundle's entry point: production-first-install dispatches to first_install unchanged.
                return production.main(argv,self.fmt,self.base,update)
        finally:
            self.stdout+=stdout.getvalue();self.stderr+=stderr.getvalue()
    def mutations(self):return [event for event in self.events if isinstance(event,list) and event[0]=='/usr/bin/systemctl' and any(word in event for word in MUTATING)]
    @property
    def operation(self):return self.app/'installs'/self.source
    @property
    def release(self):return self.app/'releases'/self.source

class ProductionFirstInstallTests(unittest.TestCase):
    def fixture(self,tmp,**options):return ProductionFixture(Path(tmp).resolve(),**options)
    def assert_no_secret(self,f,*texts):
        for text in (f.stdout,f.stderr,*texts):
            self.assertNotIn(APP_SECRET,text);self.assertNotIn(OWNER_SECRET,text)
    def assert_prior_preserved(self,f,env_bytes):
        self.assertEqual(f.env.read_bytes(),env_bytes);self.assertEqual(f.env.stat().st_mode&0o777,0o600)
        for prior in PRIOR:self.assertEqual((f.app/'releases'/prior/'package.json').read_text(),'prior '+prior)
        self.assertFalse(any(isinstance(event,list) and 'kill' in event for event in f.events))
    def assert_refused_without_change(self,f,env_bytes,error,unit=None):
        self.assertEqual(f.mutations(),[]);self.assertFalse((f.app/'installs').exists());self.assertFalse(f.release.exists())
        self.assertEqual(f.unit.read_bytes() if f.unit.exists() else None,unit);self.assert_prior_preserved(f,env_bytes)
        self.assert_no_secret(f,''.join(traceback.format_exception(error)))
    def refuse(self,f,overrides=None):
        # A refusal is a check failure, or an OS-level failure such as a refused loopback connection.
        with self.assertRaises((ValueError,OSError)) as caught:f.invoke(overrides)
        return caught.exception
    def test_first_activation_on_simulated_production_layout(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=self.fixture(tmp);env_bytes=f.env.read_bytes();accepted=f.invoke()
            unit=install.service_unit(f.source).encode();self.assertEqual(f.unit.read_bytes(),unit);self.assertEqual(f.unit.stat().st_mode&0o777,0o644)
            for line in ['User=aihr-import','Group=aihr-import','WorkingDirectory=/opt/aihr-import/releases/'+f.source,'Environment=AIHR_DB_PROCESS_ROLE=worker','Environment=AIHR_DB_POOL_MAX=2',
                         'EnvironmentFile=/etc/aihr/import-worker.env','ExecStart=/opt/node22/bin/node --import tsx scripts/bank-import-runner.ts','Restart=on-failure']:
                self.assertIn(line+'\n',unit.decode())
            self.assertNotIn(b'SendSIGKILL',unit);self.assertNotIn(b'ExecStartPre',unit)
            self.assertEqual(f.mutations(),[['/usr/bin/systemctl','daemon-reload'],['/usr/bin/systemctl','start','aihr-bank-import.service'],['/usr/bin/systemctl','enable','aihr-bank-import.service']])
            self.assertEqual(f.state['ActiveState'],'active');self.assertEqual(f.state['UnitFileState'],'enabled')
            self.assert_prior_preserved(f,env_bytes)
            self.assertEqual(sorted(p.name for p in (f.app/'releases').iterdir()),sorted([*PRIOR,f.source]))
            self.assertEqual(sorted(p.name for p in f.unit_dirs[0].iterdir()),sorted(['aihr.service','aihr-bank-import.service','multi-user.target.wants']))
            receipt_path=f.release/'worker-install-v2.json';receipt=json.loads(receipt_path.read_text());self.assertEqual(receipt_path.stat().st_mode&0o777,0o444)
            self.assertEqual(receipt,accepted);self.assertEqual(receipt,json.loads((f.operation/'activated.json').read_text()))
            self.assertEqual(receipt['mode'],'production-first-install');self.assertEqual(receipt['source'],f.source);self.assertEqual(receipt['webBuildId'],f.build)
            self.assertEqual(receipt['existingUid'],f.uid);self.assertEqual(receipt['workerPid'],456);self.assertTrue(receipt['serviceStable']);self.assertFalse(receipt['journeyVerified'])
            self.assertEqual(receipt['releaseManifestSha256'],f.manifest_hash)
            # The receipt binds exactly what the later managed drain validates: the template unit and the adopted env bytes.
            self.assertEqual(receipt['unitSha256'],update.digest(unit));self.assertEqual(receipt['selectedEnvironmentSha256'],update.digest(env_bytes))
            preflight=json.loads((f.operation/'preflight.json').read_text())
            self.assertEqual(preflight['priorReleases'],sorted(PRIOR));self.assertTrue(preflight['remoteDatabaseTls'])
            self.assertEqual(preflight['environmentKeys'],sorted(f.values))
            self.assertEqual([event for event in f.events if isinstance(event,list) and event[0]==production.PSQL],[[production.PSQL,'-X','-q','-A','-t','--no-password','-v','ON_ERROR_STOP=1']]*2)
            self.assertLess(f.events.index('extract'),f.events.index(['/usr/bin/systemctl','daemon-reload']))
            self.assert_no_secret(f,*(path.read_text() for path in f.operation.iterdir() if path.suffix=='.json'))
            with self.assertRaises(ValueError):f.invoke()
    def test_first_activation_when_systemd_omits_unset_properties(self):
        # systemd 255 (Ubuntu 24.04, production) omits unset properties, before and after the unit exists.
        with tempfile.TemporaryDirectory() as tmp:
            f=self.fixture(tmp,omit_empty=True);f.invoke()
            self.assertEqual(f.state['ActiveState'],'active');self.assertEqual(f.state['UnitFileState'],'enabled')
            self.assertTrue((f.release/'worker-install-v2.json').exists())
            shown=f.show(f.state,['ExecStartPre','DropInPaths','PassEnvironment']);self.assertEqual(shown,'\n')
    def test_adopts_the_production_shaped_environment_file_and_observes_unquoted_values(self):
        # Read-only production observation (12 Nov): 0600 root:root; exactly these five keys in this order; every value
        # double-quoted with no $, backslash, space or inner quote; no comments or blank lines; remote host, verify-full;
        # both CA paths under /etc/ssl/certs. systemd strips the quotes, so the live process sees unquoted values.
        order=['AUDIT_HASH_CHAIN_ENABLED','DATABASE_URL','MIGRATION_DATABASE_URL','NODE_EXTRA_CA_CERTS','PGSSLROOTCERT']
        ca=Path('/etc/ssl/certs/aihr-db-ca.pem')
        def production_shaped(f):
            f.external={ca};f.ca=ca;f.values.update(NODE_EXTRA_CA_CERTS=str(ca),PGSSLROOTCERT=str(ca))
            text=''.join(key+'="'+f.values[key]+'"\n' for key in order)
            self.assertEqual([line.split('=',1)[0] for line in text.splitlines()],order);self.assertEqual(text.count('"'),10)
            self.assertNotIn('#',text);self.assertNotIn('\n\n',text);self.assertTrue(text.startswith('AUDIT_HASH_CHAIN_ENABLED="true"\n'))
            for key in ('DATABASE_URL','MIGRATION_DATABASE_URL'):self.assertIn(key+'="postgresql://',text)
            self.assertEqual(text.count('@db.internal.invalid:5432/ai_hr?sslmode=verify-full"\n'),2)
            f.write_env(text);self.assertEqual(f.env.stat().st_mode&0o777,0o600)
            return f.env.read_bytes()
        with tempfile.TemporaryDirectory() as tmp:
            f=self.fixture(tmp);env_bytes=production_shaped(f);accepted=f.invoke()
            environ=dict(item.split(b'=',1) for item in (f.proc/'456'/'environ').read_bytes().split(b'\0') if item)
            for key in order:
                self.assertEqual(environ[key.encode()],f.values[key].encode());self.assertNotIn(b'"',environ[key.encode()])
            self.assertEqual(f.env.read_bytes(),env_bytes);self.assertEqual(accepted['selectedEnvironmentSha256'],update.digest(env_bytes))
            self.assertEqual(f.mutations(),[['/usr/bin/systemctl','daemon-reload'],['/usr/bin/systemctl','start','aihr-bank-import.service'],['/usr/bin/systemctl','enable','aihr-bank-import.service']])
            self.assertIn(['/usr/sbin/runuser','--user','aihr-import','--','/usr/bin/test','-r',str(ca)],f.events)
            preflight=json.loads((f.operation/'preflight.json').read_text())
            self.assertEqual(preflight['environmentKeys'],sorted(order));self.assertTrue(preflight['remoteDatabaseTls'])
            self.assert_no_secret(f,*(path.read_text() for path in f.operation.iterdir() if path.suffix=='.json'))
        # The observation compares unquoted values: a process that received the quote characters is not accepted.
        with tempfile.TemporaryDirectory() as tmp:
            f=self.fixture(tmp);env_bytes=production_shaped(f);f.fault='quoted-env'
            with self.assertRaisesRegex(RuntimeError,'activation failed'):f.invoke()
            self.assertFalse((f.release/'worker-install-v2.json').exists());self.assertIn('SendSIGKILL=no',f.unit.read_text())
            self.assert_prior_preserved(f,env_bytes);self.assert_no_secret(f)
    def test_refuses_existing_unit_drop_in_or_link(self):
        defects=['unit','drop-in','template','wants-link','loaded','masked','tracked-cgroup']
        for defect in defects:
            with self.subTest(defect=defect),tempfile.TemporaryDirectory() as tmp:
                f=self.fixture(tmp);env_bytes=f.env.read_bytes();unit=None
                if defect=='unit':f.unit.write_text('earlier unit');unit=b'earlier unit'
                if defect=='drop-in':(f.unit_dirs[1]/'aihr-bank-import.service.d').mkdir()
                if defect=='template':(f.unit_dirs[2]/'aihr-bank-import@.service').write_text('template')
                if defect=='wants-link':(f.unit_dirs[0]/'multi-user.target.wants'/'aihr-bank-import.service').symlink_to('/nonexistent/aihr-bank-import.service')
                if defect=='loaded':f.state.update(LoadState='loaded',FragmentPath='/usr/lib/systemd/system/aihr-bank-import.service')
                if defect=='masked':f.state['LoadState']='masked'
                if defect=='tracked-cgroup':f.state['ControlGroup']='/system.slice/aihr-bank-import.service'
                error=self.refuse(f);self.assertIn('first activation only',str(error))
                self.assert_refused_without_change(f,env_bytes,error,unit)
    def test_refuses_a_process_running_as_the_worker_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=self.fixture(tmp);f.live=[777];env_bytes=f.env.read_bytes()
            error=self.refuse(f);self.assertIn('process runs as aihr-import',str(error));self.assert_refused_without_change(f,env_bytes,error)
    def test_refuses_web_that_is_not_the_exact_pinned_source_and_build(self):
        defects=['build','manifest-commit','manifest-build','manifest-pin','source','inactive','user','directory','unhealthy','body','oversize','port']
        for defect in defects:
            with self.subTest(defect=defect),tempfile.TemporaryDirectory() as tmp:
                f=self.fixture(tmp);env_bytes=f.env.read_bytes();overrides={}
                if defect=='build':(f.web_app/'.next'/'BUILD_ID').write_text('other-build\n')
                if defect=='manifest-commit':f.write_manifest({'schemaVersion':1,'commit':'3'*40,'buildId':f.build,'platform':'linux','architecture':'x86_64'})
                if defect=='manifest-build':f.write_manifest({'schemaVersion':1,'commit':f.source,'buildId':'other-build','platform':'linux','architecture':'x86_64'})
                if defect=='manifest-pin':overrides['release-manifest-sha256']='c'*64
                if defect=='source':overrides['source']='3'*40
                if defect=='inactive':f.web.update(ActiveState='inactive',SubState='dead',MainPID='0')
                if defect=='user':f.web['User']='root'
                if defect=='directory':f.web['WorkingDirectory']='/opt/ai-hr-old'
                if defect=='unhealthy':f.health_status=503
                if defect=='body':f.health_body=b'{"status":"degraded"}'
                if defect=='oversize':f.health_body=b' '*4097
                if defect=='port':overrides['web-port']='3001'
                error=self.refuse(f,overrides);self.assert_refused_without_change(f,env_bytes,error)
    def test_rechecks_every_refusal_immediately_before_creating_the_unit(self):
        for fault in ['prepare-web','prepare-process','prepare-unit','prepare-env']:
            with self.subTest(fault=fault),tempfile.TemporaryDirectory() as tmp:
                f=self.fixture(tmp);f.fault=fault
                with self.assertRaises(ValueError):f.invoke()
                self.assertEqual(f.mutations(),[]);self.assertFalse((f.operation/'activated.json').exists())
                self.assertTrue((f.operation/'preflight.json').exists());self.assertFalse((f.release/'worker-install-v2.json').exists())
                if fault=='prepare-unit':self.assertEqual(f.unit.read_text(),'foreign unit')
                else:self.assertFalse(f.unit.exists())
                for prior in PRIOR:self.assertEqual((f.app/'releases'/prior/'package.json').read_text(),'prior '+prior)
                with self.assertRaisesRegex(ValueError,'immutable release|existing installation attempt|first activation only|process runs|differs'):f.invoke()
    def test_refuses_unreviewed_or_unpinned_environment_without_printing_it(self):
        defects=['extra-key','pool-override','export','duplicate','dollar','backslash','trailing-space','crlf','missing-owner-url','pin','world-readable','group-writable']
        for defect in defects:
            with self.subTest(defect=defect),tempfile.TemporaryDirectory() as tmp:
                f=self.fixture(tmp);overrides={};text=f.render(f.values)
                if defect=='extra-key':text+='PORT=3000\n'
                if defect=='pool-override':text+='AIHR_DB_POOL_MAX=16\n'
                if defect=='export':text=text.replace('DATABASE_URL=','export DATABASE_URL=',1)
                if defect=='duplicate':text+='DATABASE_URL=postgresql://ai_hr_app:'+APP_SECRET+'@db.internal.invalid:5432/ai_hr?sslmode=verify-full\n'
                if defect=='dollar':text=text.replace(APP_SECRET,APP_SECRET+'$HOME')
                if defect=='backslash':text=text.replace(OWNER_SECRET,OWNER_SECRET+'\\n')
                if defect=='trailing-space':text=text.replace('AUDIT_HASH_CHAIN_ENABLED=true','AUDIT_HASH_CHAIN_ENABLED=true ')
                if defect=='crlf':text=text.replace('\n','\r\n')
                if defect=='missing-owner-url':text=f.render({k:v for k,v in f.values.items() if k!='MIGRATION_DATABASE_URL'})
                if defect=='pin':overrides['worker-env-sha256']='d'*64
                f.write_env(text,{'world-readable':0o644,'group-writable':0o660}.get(defect,0o600));env_bytes=f.env.read_bytes()
                error=self.refuse(f,overrides);self.assertEqual(f.mutations(),[]);self.assertFalse((f.app/'installs').exists());self.assertFalse(f.release.exists())
                self.assertEqual(f.env.read_bytes(),env_bytes);self.assert_no_secret(f,''.join(traceback.format_exception(error)))
                self.assertNotIn('$HOME',str(error));self.assertNotIn('PORT',str(error))
    def test_database_urls_accept_remote_tls_and_check_roles_without_printing_them(self):
        base=SimpleNamespace(check=install.check)
        app='postgresql://ai_hr_app:'+APP_SECRET+'@db.internal.invalid:6432/ai_hr?sslmode=verify-full'
        config,remote=production.database_config(base,app,'ai_hr_app')
        self.assertTrue(remote);self.assertEqual({k:config[k] for k in ('PGHOST','PGPORT','PGUSER','PGDATABASE','PGSSLMODE')},
            {'PGHOST':'db.internal.invalid','PGPORT':'6432','PGUSER':'ai_hr_app','PGDATABASE':'ai_hr','PGSSLMODE':'verify-full'})
        config,remote=production.database_config(base,'postgresql://ai_hr_owner:'+OWNER_SECRET+'@127.0.0.1/ai_hr','ai_hr_owner');self.assertFalse(remote);self.assertEqual(config['PGPORT'],'5432')
        refused=['postgresql://ai_hr_app:'+APP_SECRET+'@db.internal.invalid/ai_hr','postgresql://ai_hr_app:'+APP_SECRET+'@db.internal.invalid/ai_hr?sslmode=require',
                 'postgresql://ai_hr_app:'+APP_SECRET+'@db.internal.invalid/ai_hr?sslmode=verify-full&sslmode=disable','postgresql://ai_hr_app:'+APP_SECRET+'@db.internal.invalid/ai_hr?sslmode=verify-full&ssl=false',
                 'postgresql://ai_hr_app:'+APP_SECRET+'@db.internal.invalid/ai_hr?sslmode=verify-full&user=postgres','postgresql://ai_hr_app:'+APP_SECRET+'@db.internal.invalid/ai_hr?sslmode=verify-full&options=-csearch_path%3Dx',
                 'postgresql://ai_hr_owner:'+APP_SECRET+'@db.internal.invalid/ai_hr?sslmode=verify-full','postgresql://ai_hr_app:'+APP_SECRET+'@db.internal.invalid/other?sslmode=verify-full',
                 'postgresql://ai_hr_app@db.internal.invalid/ai_hr?sslmode=verify-full','postgresql://ai_hr_app:'+APP_SECRET+'@db.internal.invalid:port'+APP_SECRET+'/ai_hr?sslmode=verify-full',
                 'postgresql://ai_hr_app:'+APP_SECRET+'@db.internal.invalid/ai_hr?sslmode=verify-full#'+APP_SECRET,'mysql://ai_hr_app:'+APP_SECRET+'@db.internal.invalid/ai_hr?sslmode=verify-full',
                 'postgresql://ai_hr_app:'+APP_SECRET+'@db.internal.invalid/ai_hr?'+APP_SECRET]
        for uri in refused:
            with self.subTest(uri=uri.replace(APP_SECRET,'<secret>')):
                with self.assertRaises(ValueError) as caught:production.database_config(base,uri,'ai_hr_app')
                self.assertNotIn(APP_SECRET,''.join(traceback.format_exception(caught.exception)))
    def test_refuses_unsafe_database_configuration_before_any_change(self):
        cases=['swapped-roles','other-host','other-port','no-node-ca','no-libpq-ca','pgsslmode','ca-unreadable','db-owner','db-bypass']
        for case in cases:
            with self.subTest(case=case),tempfile.TemporaryDirectory() as tmp:
                f=self.fixture(tmp);values=dict(f.values)
                if case=='swapped-roles':values['DATABASE_URL'],values['MIGRATION_DATABASE_URL']=values['MIGRATION_DATABASE_URL'],values['DATABASE_URL']
                if case=='other-host':values['MIGRATION_DATABASE_URL']=values['MIGRATION_DATABASE_URL'].replace('db.internal','db2.internal')
                if case=='other-port':values['MIGRATION_DATABASE_URL']=values['MIGRATION_DATABASE_URL'].replace(':5432',':6432')
                if case=='no-node-ca':values.pop('NODE_EXTRA_CA_CERTS')
                if case=='no-libpq-ca':values.pop('PGSSLROOTCERT')
                if case=='pgsslmode':values['PGSSLMODE']='require'
                if case in ('ca-unreadable','db-owner','db-bypass'):f.fault=case.replace('ca-','')
                f.write_env(f.render(values));env_bytes=f.env.read_bytes()
                error=self.refuse(f);self.assert_refused_without_change(f,env_bytes,error)
    def test_refuses_identity_that_is_not_the_pinned_system_account(self):
        cases=['missing','uid-pin','login-shell','supplementary','web-group','shared-uid','shared-gid','writable-home','regular-user']
        for case in cases:
            with self.subTest(case=case),tempfile.TemporaryDirectory() as tmp:
                f=self.fixture(tmp);env_bytes=f.env.read_bytes();overrides={}
                if case=='missing':f.identity=None
                if case=='uid-pin':overrides['existing-uid']='997'
                if case=='login-shell':f.identity.pw_shell='/bin/bash'
                if case=='supplementary':f.groups.append(SimpleNamespace(gr_name='ssl-cert',gr_gid=110,gr_mem=['aihr-import']))
                if case=='web-group':f.groups[1].gr_mem.append('aihr-import')
                if case=='shared-uid':f.accounts.append(SimpleNamespace(pw_name='other',pw_uid=f.uid,pw_gid=1,pw_shell='/bin/sh',pw_dir='/'))
                if case=='shared-gid':f.groups.append(SimpleNamespace(gr_name='other',gr_gid=f.gid,gr_mem=[]))
                if case=='writable-home':home=f.root/'home-aihr-import';home.mkdir();f.identity.pw_dir=str(home)
                if case=='regular-user':f.identity.pw_uid=1001;f.uid=1001;overrides['existing-uid']='1001'
                error=self.refuse(f,overrides);self.assert_refused_without_change(f,env_bytes,error)
    def test_failures_after_unit_creation_quarantine_without_sigkill_or_rollback(self):
        for fault in ['reload','start','restart','env-drift','final-web','enable','receipt']:
            with self.subTest(fault=fault),tempfile.TemporaryDirectory() as tmp:
                f=self.fixture(tmp);env_bytes=f.env.read_bytes();f.fault=fault
                with self.assertRaisesRegex(RuntimeError,'activation failed'):f.invoke()
                text=f.unit.read_text();self.assertIn('Restart=no\nSendSIGKILL=no\n',text);self.assertNotIn('Restart=on-failure',text)
                observed=json.loads((f.operation/'activation-failure-observation.json').read_text())
                self.assertTrue(observed['stopped']);self.assertTrue(observed['disabled']);self.assertFalse(observed['accepted']);self.assertFalse(observed['forcedKill'])
                self.assertTrue((f.operation/'activation-failed.json').exists());self.assertFalse((f.operation/'activated.json').exists())
                self.assertFalse((f.release/'worker-install-v2.json').exists());self.assertTrue((f.release/'package.json').exists())
                self.assertEqual(f.state['MainPID'],'0');self.assertEqual(f.state['UnitFileState'],'disabled');self.assertEqual(f.state['SendSIGKILL'],'no')
                self.assert_prior_preserved(f,env_bytes);self.assert_no_secret(f)
                self.assertIn('workerActivationFailed',f.stderr)
                with self.assertRaises(ValueError):f.invoke()
    def test_unverifiable_quarantine_never_arms_a_timed_stop(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=self.fixture(tmp);f.fault='drop-in-after-reload'
            with self.assertRaisesRegex(RuntimeError,'activation failed'):f.invoke()
            observed=json.loads((f.operation/'activation-failure-observation.json').read_text())
            self.assertFalse(observed['stopped']);self.assertTrue(observed['quiescenceUnconfirmed'])
            commands=f.mutations();self.assertNotIn(['/usr/bin/systemctl','start','aihr-bank-import.service'],commands)
            self.assertFalse(any('stop' in event for event in commands));self.assertFalse(any('kill' in event for event in commands))
    def test_production_bundle_is_self_contained_and_exposes_only_production_phases(self):
        with tempfile.TemporaryDirectory() as tmp:
            output=Path(tmp)/'helper.py'
            result=subprocess.run([sys.executable,'-I','-B',str(ROOT/'scripts/bank-import-worker-production-bundle.py'),str(output)],capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr);summary=json.loads(result.stdout)
            self.assertEqual(summary['phases'],['production-first-install','production-drain','production-activate','production-rollback'])
            self.assertEqual(tuple(summary['phases']),production.PHASES);self.assertFalse(summary['releaseAuthorized']);self.assertFalse(summary['productionAuthorized'])
            self.assertEqual(summary['helperSha256'],hashlib.sha256(output.read_bytes()).hexdigest());self.assertEqual(summary['bytes'],len(output.read_bytes()))
            self.assertIn('deploy/systemd/bank_import_worker_production_v1.py',summary['sourceFiles'])
            body=output.read_text();self.assertNotIn('spec_from_file_location',body);self.assertIn('types.ModuleType',body);self.assertEqual(output.stat().st_mode&0o777,0o600)
            self.assertTrue(body.endswith('production.main(sys.argv[1:],fmt,base,update)\n'))
            result=subprocess.run([sys.executable,'-I','-B',str(output),'--help'],capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertIn('{production-first-install,production-drain,production-activate,production-rollback}',result.stdout)
            flags={'production-first-install':['--source','--build-id','--web-port','--release-manifest','--release-manifest-sha256','--archive','--archive-sha256','--lock-sha256','--package-sha256','--worker-env-sha256','--existing-uid'],
                   'production-drain':['--'+name for name in production.UPDATE_ARGS],'production-activate':['--'+name for name in production.UPDATE_ARGS],
                   'production-rollback':['--'+name for name in production.ROLLBACK_ARGS]}
            for phase,expected in flags.items():
                result=subprocess.run([sys.executable,'-I','-B',str(output),phase,'--help'],capture_output=True,text=True)
                self.assertEqual(result.returncode,0,result.stderr)
                for flag in expected:self.assertIn(flag,result.stdout)
                for staging in ['adopt-stopped','--observed-unit-sha256']:self.assertNotIn(staging,result.stdout)
            for phase in ['drain','activate','adopt-stopped','','production-update']:
                refused=subprocess.run([sys.executable,'-I','-B',str(output),*([phase] if phase else [])],capture_output=True,text=True);self.assertEqual(refused.returncode,2)
            update_pins=[part for name in production.UPDATE_ARGS for part in ('--'+name,{'web-port':'3000','existing-uid':'998'}.get(name,'a'*64))]
            for phase in ['production-drain','production-activate']:
                missing=subprocess.run([sys.executable,'-I','-B',str(output),phase,*update_pins[:-2]],capture_output=True,text=True)
                self.assertEqual(missing.returncode,2);self.assertIn('--existing-uid',missing.stderr)
            pins=['--source','2'*40,'--build-id','b','--web-port','3000','--release-manifest','/m','--release-manifest-sha256','a'*64,'--archive','/a','--archive-sha256','a'*64,
                  '--lock-sha256','a'*64,'--package-sha256','a'*64,'--worker-env-sha256','a'*64,'--existing-uid','998']
            missing=subprocess.run([sys.executable,'-I','-B',str(output),'production-first-install',*pins[:-2]],capture_output=True,text=True)
            self.assertEqual(missing.returncode,2);self.assertIn('--existing-uid',missing.stderr)
            if os.geteuid()!=0:
                unprivileged=subprocess.run([sys.executable,'-I','-B',str(output),'production-first-install',*pins],capture_output=True,text=True)
                self.assertNotEqual(unprivileged.returncode,0);self.assertIn('root must run',unprivileged.stderr)
            duplicate=subprocess.run([sys.executable,'-I','-B',str(ROOT/'scripts/bank-import-worker-production-bundle.py'),str(output)],capture_output=True,text=True)
            self.assertNotEqual(duplicate.returncode,0)


# Production update and rollback: an installed managed production release (this morning's production-first-install
# shape), the customer web check instead of staging deployment records. Simulated layout only; fictional values.
SIGTERM_DRAIN=['/usr/bin/systemctl','kill','--kill-whom=main','--signal=SIGTERM','aihr-bank-import.service']

class ProductionUpdateFixture(ProductionFixture):
    """Previous managed release running from its template unit; web on the previous pinned build; new package pinned."""
    def __init__(self,root,omit_empty=False):
        super().__init__(root,omit_empty);self.previous='1'*40;self.old_build='Pold_build-0';self.next_pid=455;self.drain_outcome='exit'
        self.previous_release=self.app/'releases'/self.previous;(self.previous_release/'scripts').mkdir(parents=True)
        (self.previous_release/'package.json').write_text('previous package');(self.previous_release/'scripts'/'bank-import-runner.ts').write_text('previous runner')
        self.unit.write_text(install.service_unit(self.previous));self.unit_hash=update.digest(self.unit.read_bytes())
        self.previous_receipt={'mode':'production-first-install','source':self.previous,'webBuildId':self.old_build,'unitSha256':self.unit_hash,
            'selectedEnvironmentSha256':self.env_hash,'serviceStable':True,'workerPid':123,'journeyVerified':False}
        self.receipt_path=self.previous_release/'worker-install-v2.json';self.receipt_path.write_text(json.dumps(self.previous_receipt));self.receipt_path.chmod(0o444)
        self.state['UnitFileState']='enabled';self.load(self.unit.read_text())
        self.state.update(ActiveState='active',SubState='running',MainPID='123',ControlGroup='/system.slice/aihr-bank-import.service')
        self.process('123',self.previous_release)
        (self.web_app/'.next'/'BUILD_ID').write_text(self.old_build+'\n')
    def process(self,pid,cwd,values=None):
        process=self.proc/pid;process.mkdir(exist_ok=True)
        (process/'status').write_bytes(b'Name:\tnode\nUid:\t'+'\t'.join([str(self.uid)]*4).encode()+b'\n')
        if (process/'cwd').is_symlink():(process/'cwd').unlink()
        (process/'cwd').symlink_to(cwd,target_is_directory=True)
        (process/'cmdline').write_bytes(b'\0'.join([str(self.node).encode(),b'--import',b'tsx',b'scripts/bank-import-runner.ts'])+b'\0')
        environment={'PATH':'/usr/bin','NODE_ENV':'production','AIHR_DB_PROCESS_ROLE':'worker','AIHR_DB_POOL_MAX':'2',**(values or self.values)}
        (process/'environ').write_bytes(b''.join((key+'='+value).encode()+b'\0' for key,value in environment.items()))
    def launch(self):
        self.next_pid+=1;pid=str(self.next_pid)
        # A manual start after a clean stop flushes the restart counter (systemd's flush_n_restarts).
        self.state.update(ActiveState='active',SubState='running',MainPID=pid,NRestarts='0',ControlGroup='/system.slice/aihr-bank-import.service')
        self.process(pid,Path(self.state['WorkingDirectory']),{**self.values,**({'DATABASE_URL':'postgresql://drifted'} if self.fault=='env-drift' else {})})
        if self.fault=='restart':self.state['NRestarts']='1'
        if self.fault=='final-web':self.web['MainPID']='999'
    def command(self,argv,input=None,env=None,allow_failure=False):
        if argv[:2]==['/usr/bin/systemctl','kill']:
            self.events.append(list(argv));check(argv==SIGTERM_DRAIN,'only a SIGTERM to the main process is reviewed')
            if self.drain_outcome=='exit':self.exit_cleanly()
            elif self.drain_outcome=='restart':self.state.update(NRestarts='1',MainPID='789')
            elif self.drain_outcome=='unclean':self.state.update(MainPID='0',ActiveState='inactive',SubState='dead',Result='exit-code',ExecMainStatus='1',ControlGroup='')
            return SimpleNamespace(stdout='',returncode=0)
        result=super().command(argv,input,env,allow_failure)
        if argv[:2]==['/usr/bin/systemctl','stop']:self.state.update(ControlGroup='',Result='success',ExecMainStatus='0')
        return result
    def exit_cleanly(self):self.state.update(MainPID='0',ActiveState='inactive',SubState='dead',Result='success',ExecMainStatus='0',ControlGroup='')
    def install_new_web(self):(self.web_app/'.next'/'BUILD_ID').write_text(self.build+'\n');self.web['MainPID']='654'
    def roll_web_back(self):(self.web_app/'.next'/'BUILD_ID').write_text(self.old_build+'\n');self.web['MainPID']='655'
    def update_args(self,phase,overrides=None):
        values={'previous-worker-source':self.previous,'unit-sha256':self.unit_hash,'previous-web-source':self.previous,'previous-web-build':self.old_build,
            'source':self.source,'build-id':self.build,'web-port':str(self.port),'release-manifest':str(self.manifest_path),'release-manifest-sha256':self.manifest_hash,
            'archive':str(self.archive),'archive-sha256':update.digest(self.archive.read_bytes()),'lock-sha256':'a'*64,'package-sha256':'b'*64,
            'worker-env-sha256':self.env_hash,'existing-uid':str(self.uid)}
        values.update(overrides or {})
        return [phase,*[part for key,value in values.items() if value is not None for part in ('--'+key,value)]]
    def rollback_args(self,overrides=None):
        values={'from-source':self.source,'to-source':self.previous,'unit-sha256':update.digest(self.unit.read_bytes()),'to-unit-sha256':self.unit_hash,
            'web-source':self.previous,'web-build':self.old_build,'web-port':str(self.port),'worker-env-sha256':self.env_hash,'existing-uid':str(self.uid)}
        values.update(overrides or {})
        return ['production-rollback',*[part for key,value in values.items() if value is not None for part in ('--'+key,value)]]
    def drain(self,overrides=None,extra=()):return self.call(self.update_args('production-drain',overrides),extra)
    def activate(self,overrides=None):return self.call(self.update_args('production-activate',overrides))
    def rollback(self,overrides=None):return self.call(self.rollback_args(overrides))
    @property
    def operation(self):return self.app/'upgrades'/self.source
    def prepared(self):return sorted(path for path in (self.app/'upgrades').iterdir() if path.name.startswith('.production-drain-')) if (self.app/'upgrades').exists() else []
    def signals(self):return [event for event in self.events if isinstance(event,list) and event[:2]==['/usr/bin/systemctl','kill']]

class ProductionUpdateTests(unittest.TestCase):
    def fixture(self,tmp,**options):return ProductionUpdateFixture(Path(tmp).resolve(),**options)
    def assert_previous_intact(self,f,env_bytes):
        self.assertEqual(f.env.read_bytes(),env_bytes);self.assertEqual(f.env.stat().st_mode&0o777,0o600)
        self.assertEqual(json.loads(f.receipt_path.read_text()),f.previous_receipt);self.assertEqual((f.previous_release/'package.json').read_text(),'previous package')
        for prior in PRIOR:self.assertEqual((f.app/'releases'/prior/'package.json').read_text(),'prior '+prior)
        # The only signal ever sent is the drain's SIGTERM to the main process; no SIGKILL in any command.
        self.assertTrue(all(event==SIGTERM_DRAIN for event in f.signals()))
        self.assertFalse(any(item in ('--signal=SIGKILL','--signal=KILL','-9') for event in f.events if isinstance(event,list) for item in event))
    def assert_refused_before_any_change(self,f,env_bytes,error=None):
        self.assertEqual(f.mutations(),[]);self.assertEqual(f.signals(),[]);self.assertFalse((f.app/'upgrades').exists())
        self.assertFalse(f.release.exists());self.assertEqual(f.unit.read_bytes(),install.service_unit(f.previous).encode())
        self.assertEqual(f.state['MainPID'],'123');self.assert_previous_intact(f,env_bytes)
        if error is not None:self.assert_no_secret(f,''.join(traceback.format_exception(error)))
    def assert_no_secret(self,f,*texts):
        for text in (f.stdout,f.stderr,*texts):self.assertNotIn(APP_SECRET,text);self.assertNotIn(OWNER_SECRET,text)
    def refuse(self,call):
        with self.assertRaises((ValueError,OSError)) as caught:call()
        return caught.exception
    def test_update_drains_before_the_web_install_and_activates_after_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=self.fixture(tmp);env_bytes=f.env.read_bytes();drained=f.drain()
            self.assertEqual(f.mutations(),[SIGTERM_DRAIN]);self.assertEqual(drained['drain'],{'pid':123,'state':'drained','alreadyStopped':False,'forcedKill':False})
            self.assertLess(f.events.index('extract'),f.events.index(SIGTERM_DRAIN));self.assertEqual(f.prepared(),[])
            record=json.loads((f.operation/'drained.json').read_text());self.assertEqual(record['mode'],'production-drain')
            self.assertEqual(record['identity']['previous_web_build'],f.old_build);self.assertEqual(record['web']['webSource'],f.previous)
            self.assertEqual(record['web']['webBuildId'],f.old_build);self.assertTrue((f.operation/'authenticated-worker.zip').exists())
            self.assertEqual(f.unit.read_bytes(),install.service_unit(f.previous).encode());self.assertEqual(f.state['UnitFileState'],'enabled')
            self.assertFalse(f.release.exists())
            f.install_new_web();accepted=f.activate()
            unit=install.service_unit(f.source).encode();self.assertEqual(f.unit.read_bytes(),unit)
            self.assertEqual(f.mutations(),[SIGTERM_DRAIN,['/usr/bin/systemctl','daemon-reload'],['/usr/bin/systemctl','start','aihr-bank-import.service']])
            self.assertEqual(f.state['ActiveState'],'active');self.assertEqual(f.state['UnitFileState'],'enabled');self.assertEqual(f.state['WorkingDirectory'],str(f.release))
            receipt=json.loads((f.release/'worker-install-v2.json').read_text());self.assertEqual(receipt,accepted)
            self.assertEqual(receipt,json.loads((f.operation/'activated.json').read_text()));self.assertEqual((f.release/'worker-install-v2.json').stat().st_mode&0o777,0o444)
            self.assertEqual(receipt['mode'],'production-update');self.assertEqual(receipt['source'],f.source);self.assertEqual(receipt['webBuildId'],f.build)
            self.assertEqual(receipt['unitSha256'],update.digest(unit));self.assertEqual(receipt['selectedEnvironmentSha256'],update.digest(env_bytes))
            self.assertEqual(receipt['previousWorkerSource'],f.previous);self.assertEqual(receipt['previousUnitSha256'],f.unit_hash)
            self.assertEqual(receipt['previousWebSource'],f.previous);self.assertEqual(receipt['previousWebBuildId'],f.old_build)
            self.assertEqual(receipt['releaseManifestSha256'],f.manifest_hash);self.assertEqual(receipt['workerPid'],456);self.assertFalse(receipt['journeyVerified'])
            self.assertTrue(f.previous_release.is_dir());self.assert_previous_intact(f,env_bytes);self.assert_no_secret(f,*(p.read_text() for p in f.operation.iterdir() if p.suffix=='.json'))
            self.assertEqual(len([e for e in f.events if isinstance(e,list) and e[0]==production.PSQL]),2)
            with self.assertRaises(ValueError):f.activate()
    def test_a_later_production_drain_validates_the_new_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=self.fixture(tmp);f.drain();f.install_new_web();accepted=f.activate()
            with patch.object(install,'command',side_effect=f.command):
                report,receipt=production.managed_release(f.base,update,f.source,accepted['unitSha256'],f.env_hash)
            self.assertEqual(receipt,accepted);self.assertEqual(report['WorkingDirectory'],str(f.release))
    def test_drain_after_the_web_install_also_accepts_the_new_pinned_web(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=self.fixture(tmp);f.install_new_web();drained=f.drain()
            self.assertEqual(drained['web']['webSource'],f.source);self.assertEqual(drained['web']['webBuildId'],f.build)
            f.activate();self.assertEqual(f.unit.read_bytes(),install.service_unit(f.source).encode())
    def test_drain_accepts_a_worker_that_restarted_earlier_and_systemd_that_omits_unset_properties(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=self.fixture(tmp,omit_empty=True);f.state['NRestarts']='1';f.drain();f.install_new_web();f.activate()
            self.assertEqual(f.state['ActiveState'],'active');self.assertEqual(f.state['NRestarts'],'0')
    def test_refuses_a_wrong_previous_receipt_before_any_change(self):
        defects=['missing','staging-receipt','adopted-receipt','source','unit','environment','not-stable','web-build','previous-source-pin','not-enabled','drop-in','other-directory']
        for defect in defects:
            with self.subTest(defect=defect),tempfile.TemporaryDirectory() as tmp:
                f=self.fixture(tmp);env_bytes=f.env.read_bytes();overrides={};receipt=dict(f.previous_receipt)
                if defect=='staging-receipt':receipt.pop('mode')
                if defect=='adopted-receipt':receipt['mode']='adopt-stopped'
                if defect=='source':receipt['source']='3'*40
                if defect=='unit':receipt['unitSha256']='c'*64
                if defect=='environment':receipt['selectedEnvironmentSha256']='d'*64
                if defect=='not-stable':receipt['serviceStable']=False
                if defect=='web-build':receipt['webBuildId']='other-build'
                if defect=='previous-source-pin':overrides['previous-worker-source']='3'*40
                if defect=='not-enabled':f.state['UnitFileState']='disabled'
                if defect=='drop-in':f.state['DropInPaths']='/etc/systemd/system/aihr-bank-import.service.d/override.conf'
                if defect=='other-directory':f.state['WorkingDirectory']=str(f.app/'releases'/PRIOR[0])
                f.receipt_path.chmod(0o644)
                if defect=='missing':f.receipt_path.unlink()
                else:f.receipt_path.write_text(json.dumps(receipt))
                f.receipt_path.exists() and f.receipt_path.chmod(0o444);f.previous_receipt=receipt
                error=self.refuse(lambda:f.drain(overrides))
                self.assertEqual(f.mutations(),[]);self.assertEqual(f.signals(),[]);self.assertFalse((f.app/'upgrades').exists());self.assertFalse(f.release.exists())
                self.assertEqual(f.state['MainPID'],'123');self.assertEqual(f.env.read_bytes(),env_bytes);self.assert_no_secret(f,''.join(traceback.format_exception(error)))
    def test_refuses_a_unit_sha_mismatch_before_any_change(self):
        for defect in ['pin','bytes','foreign-template','reload-pending']:
            with self.subTest(defect=defect),tempfile.TemporaryDirectory() as tmp:
                f=self.fixture(tmp);env_bytes=f.env.read_bytes();overrides={}
                if defect=='pin':overrides['unit-sha256']='e'*64
                if defect=='bytes':f.unit.write_text(install.service_unit(f.previous)+'# edited\n')
                if defect=='foreign-template':f.unit.write_text(install.service_unit(f.source));overrides['unit-sha256']=update.digest(f.unit.read_bytes())
                if defect=='reload-pending':f.state['NeedDaemonReload']='yes'
                error=self.refuse(lambda:f.drain(overrides))
                self.assertEqual(f.mutations(),[]);self.assertEqual(f.signals(),[]);self.assertFalse((f.app/'upgrades').exists());self.assertFalse(f.release.exists())
                self.assert_previous_intact(f,env_bytes);self.assert_no_secret(f,''.join(traceback.format_exception(error)))
    def test_refuses_a_web_pin_mismatch_at_drain_and_at_activation(self):
        defects=['unpinned-build','previous-build-pin','manifest-pin','manifest-build','unhealthy','not-running','web-user','port','web-changes-during-preparation']
        for defect in defects:
            with self.subTest(phase='drain',defect=defect),tempfile.TemporaryDirectory() as tmp:
                f=self.fixture(tmp);env_bytes=f.env.read_bytes();overrides={}
                if defect=='unpinned-build':(f.web_app/'.next'/'BUILD_ID').write_text('Pother_build\n')
                if defect=='previous-build-pin':overrides['previous-web-build']='Pother_build'
                if defect=='manifest-pin':overrides['release-manifest-sha256']='c'*64
                if defect=='manifest-build':f.write_manifest({'schemaVersion':1,'commit':f.source,'buildId':'Pother_build','platform':'linux','architecture':'x86_64'})
                if defect=='unhealthy':f.health_status=503
                if defect=='not-running':f.web.update(ActiveState='inactive',SubState='dead',MainPID='0')
                if defect=='web-user':f.web['User']='root'
                if defect=='port':overrides['web-port']='3001'
                if defect=='web-changes-during-preparation':f.fault='prepare-web'
                error=self.refuse(lambda:f.drain(overrides))
                self.assertEqual(f.mutations(),[]);self.assertEqual(f.signals(),[]);self.assertFalse(f.operation.exists());self.assertFalse(f.release.exists())
                self.assertEqual(f.state['MainPID'],'123');self.assert_previous_intact(f,env_bytes);self.assert_no_secret(f,''.join(traceback.format_exception(error)))
        for defect in ['web-still-previous','unpinned-build','manifest-pin','unhealthy','web-changes-during-extraction']:
            with self.subTest(phase='activate',defect=defect),tempfile.TemporaryDirectory() as tmp:
                f=self.fixture(tmp);env_bytes=f.env.read_bytes();f.drain();overrides={}
                if defect!='web-still-previous':f.install_new_web()
                if defect=='unpinned-build':(f.web_app/'.next'/'BUILD_ID').write_text('Pother_build\n')
                if defect=='manifest-pin':f.write_manifest({'schemaVersion':1,'commit':'3'*40,'buildId':f.build,'platform':'linux','architecture':'x86_64'})
                if defect=='unhealthy':f.health_status=503
                if defect=='web-changes-during-extraction':f.web['MainPID']='653';f.fault='prepare-web'
                with self.assertRaises((ValueError,OSError)):f.activate(overrides)
                self.assertEqual(f.mutations(),[SIGTERM_DRAIN]);self.assertEqual(f.unit.read_bytes(),install.service_unit(f.previous).encode())
                self.assertFalse((f.operation/'activated.json').exists());self.assertEqual(f.state['MainPID'],'0');self.assert_previous_intact(f,env_bytes)
                if defect=='web-changes-during-extraction':
                    # The extracted release was set aside, not deleted; once the web is stable a second activation re-extracts.
                    self.assertFalse(f.release.exists());[aside]=[p for p in f.operation.iterdir() if p.name.startswith('refused-release-')]
                    self.assertTrue((aside/'release'/'package.json').exists());f.fault=None;f.activate()
                    self.assertEqual(f.unit.read_bytes(),install.service_unit(f.source).encode());self.assertTrue((f.release/'worker-install-v2.json').exists())
    def test_refuses_the_same_source_and_malformed_pins_before_the_lock(self):
        cases=[{'source':'1'*40},{'source':'1'*39},{'previous-web-build':'bad build'},{'unit-sha256':'E'*64},{'web-port':'0'},{'existing-uid':'-1'}]
        for overrides in cases:
            with self.subTest(overrides=overrides),tempfile.TemporaryDirectory() as tmp:
                f=self.fixture(tmp);env_bytes=f.env.read_bytes()
                with self.assertRaises(ValueError) as caught:f.drain(overrides)
                if overrides.get('source')=='1'*40:self.assertIn('different worker source',str(caught.exception))
                self.assertFalse((f.root/'install.lock').exists());self.assert_refused_before_any_change(f,env_bytes)
    def test_refuses_an_unreviewed_environment_or_identity_before_any_change(self):
        for defect in ['env-pin','env-extra-key','env-world-readable','uid-pin','login-shell','live-process-when-stopped']:
            with self.subTest(defect=defect),tempfile.TemporaryDirectory() as tmp:
                f=self.fixture(tmp);overrides={}
                if defect=='env-pin':overrides['worker-env-sha256']='d'*64
                if defect=='env-extra-key':f.write_env(f.render(f.values)+'PORT=3000\n',repin=False)
                if defect=='env-world-readable':f.env.chmod(0o644)
                if defect=='uid-pin':overrides['existing-uid']='997'
                if defect=='login-shell':f.identity.pw_shell='/bin/bash'
                if defect=='live-process-when-stopped':f.exit_cleanly();f.live=[777]
                env_bytes=f.env.read_bytes();error=self.refuse(lambda:f.drain(overrides))
                self.assertEqual(f.mutations(),[]);self.assertEqual(f.signals(),[]);self.assertFalse((f.app/'upgrades').exists())
                self.assertEqual(f.env.read_bytes(),env_bytes);self.assert_no_secret(f,''.join(traceback.format_exception(error)))
    def test_drain_timeout_never_kills_and_a_later_drain_resumes_from_the_clean_exit(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=self.fixture(tmp);env_bytes=f.env.read_bytes();f.drain_outcome='running';clock=iter(range(0,10**6,331))
            with self.assertRaisesRegex(RuntimeError,'deadline reached; nothing was killed'):
                f.drain(extra=[patch.object(production.time,'monotonic',side_effect=lambda:next(clock))])
            self.assertEqual(f.mutations(),[SIGTERM_DRAIN]);self.assertEqual(f.state['MainPID'],'123')
            self.assertFalse(any(word in event for event in f.mutations() for word in ('stop','disable','daemon-reload','start')))
            self.assertFalse(f.operation.exists());[prepared]=f.prepared()
            unfinished=json.loads((prepared/'drain-unfinished.json').read_text());self.assertEqual(unfinished,{'mode':'production-drain','signalled':True,'forcedKill':False,'refusal':'RuntimeError'})
            self.assertEqual(f.unit.read_bytes(),install.service_unit(f.previous).encode())
            f.install_new_web()
            with self.assertRaises((ValueError,OSError)):f.activate()
            self.assertEqual(f.mutations(),[SIGTERM_DRAIN]);self.assertFalse(f.release.exists())
            # The runner finishes its tick after the deadline and exits 0; a second production-drain records it without a signal.
            f.exit_cleanly();f.roll_web_back();drained=f.drain()
            self.assertEqual(drained['drain'],{'pid':None,'state':'drained','alreadyStopped':True,'forcedKill':False});self.assertEqual(f.signals(),[SIGTERM_DRAIN])
            self.assertEqual(len(f.prepared()),1);f.install_new_web();f.activate();self.assertEqual(f.state['ActiveState'],'active');self.assert_previous_intact(f,env_bytes)
    def test_drain_refuses_a_restart_or_unclean_exit_without_escalating(self):
        for outcome,message in [('restart','restarted during drain'),('unclean','did not exit successfully')]:
            with self.subTest(outcome=outcome),tempfile.TemporaryDirectory() as tmp:
                f=self.fixture(tmp);f.drain_outcome=outcome
                with self.assertRaisesRegex(ValueError,message):f.drain()
                self.assertEqual(f.mutations(),[SIGTERM_DRAIN]);self.assertFalse(f.operation.exists())
                self.assertEqual(f.unit.read_bytes(),install.service_unit(f.previous).encode())
                if outcome=='unclean':
                    # A non-zero exit is neither running nor cleanly stopped: a second drain refuses without a signal.
                    with self.assertRaisesRegex(ValueError,'neither running nor cleanly stopped'):f.drain()
                self.assertEqual(f.signals(),[SIGTERM_DRAIN]);self.assertEqual(len(f.prepared()),1)
    def test_activation_requires_the_exact_drain_record_and_a_drained_worker(self):
        for defect in ['no-drain','changed-pin','worker-restarted','foreign-record']:
            with self.subTest(defect=defect),tempfile.TemporaryDirectory() as tmp:
                f=self.fixture(tmp);overrides={}
                if defect!='no-drain':f.drain()
                f.install_new_web()
                if defect=='changed-pin':overrides['archive']=str(f.archive)+'.copy';Path(overrides['archive']).write_bytes(f.archive.read_bytes())
                if defect=='worker-restarted':f.launch()
                if defect=='foreign-record':
                    path=f.operation/'drained.json';record=json.loads(path.read_text());record['identity']['previous_web_build']='Pother';path.chmod(0o600);path.write_text(json.dumps(record));path.chmod(0o400)
                with self.assertRaises((ValueError,OSError)):f.activate(overrides)
                self.assertEqual(f.unit.read_bytes(),install.service_unit(f.previous).encode());self.assertFalse(f.release.exists())
                self.assertFalse(any(event==['/usr/bin/systemctl','daemon-reload'] for event in f.events))
    def test_activation_failure_enters_the_sigkill_free_quarantine(self):
        for fault in ['reload','start','restart','env-drift','final-web','receipt']:
            with self.subTest(fault=fault),tempfile.TemporaryDirectory() as tmp:
                f=self.fixture(tmp);env_bytes=f.env.read_bytes();f.drain();f.install_new_web();f.fault=fault
                with self.assertRaisesRegex(RuntimeError,'activation failed'):f.activate()
                text=f.unit.read_text();self.assertIn('Restart=no\nSendSIGKILL=no\n',text);self.assertIn('WorkingDirectory=/opt/aihr-import/releases/'+f.source,text)
                observed=json.loads((f.operation/'activation-failure-observation.json').read_text())
                self.assertTrue(observed['stopped']);self.assertTrue(observed['disabled']);self.assertFalse(observed['accepted']);self.assertFalse(observed['forcedKill'])
                self.assertTrue((f.operation/'activation-failed.json').exists());self.assertFalse((f.operation/'activated.json').exists())
                self.assertFalse((f.release/'worker-install-v2.json').exists());self.assertTrue((f.release/'package.json').exists())
                self.assertEqual(f.state['MainPID'],'0');self.assertEqual(f.state['UnitFileState'],'disabled')
                self.assertIn('workerActivationFailed',f.stderr);self.assert_previous_intact(f,env_bytes);self.assert_no_secret(f)
                f.fault=None
                with self.assertRaises(ValueError):f.activate()
    def rolled_back(self,f,env_bytes,record,from_state):
        self.assertEqual(f.unit.read_bytes(),install.service_unit(f.previous).encode());self.assertEqual(f.state['WorkingDirectory'],str(f.previous_release))
        self.assertEqual(f.state['ActiveState'],'active');self.assertEqual(f.state['UnitFileState'],'enabled')
        self.assertEqual(record['mode'],'production-rollback');self.assertEqual(record['fromState'],from_state);self.assertEqual(record['toSource'],f.previous)
        self.assertEqual(record['unitSha256'],f.unit_hash);self.assertFalse(record['forcedKill']);self.assertFalse(record['journeyVerified'])
        [directory]=[p for p in f.operation.iterdir() if p.name.startswith('rollback-'+f.previous+'-')]
        self.assertEqual(json.loads((directory/'rolled-back.json').read_text()),record);self.assertTrue((directory/'rollback-preflight.json').exists())
        self.assert_previous_intact(f,env_bytes);self.assertEqual(f.signals(),[SIGTERM_DRAIN])
        # The original receipt still validates, so a later production update can start from the re-activated release.
        with patch.object(install,'command',side_effect=f.command):
            report,receipt=production.managed_release(f.base,update,f.previous,f.unit_hash,f.env_hash)
        self.assertEqual(receipt,f.previous_receipt);return directory
    def test_rollback_reactivates_the_previous_release_after_an_accepted_update(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=self.fixture(tmp);env_bytes=f.env.read_bytes();f.drain();f.install_new_web();f.activate();before=len(f.mutations());f.roll_web_back()
            record=f.rollback()
            commands=f.mutations()[before:]
            self.assertEqual(commands,[['/usr/bin/systemctl','daemon-reload'],['/usr/bin/systemctl','disable','aihr-bank-import.service'],
                ['/usr/bin/systemctl','stop','--no-block','aihr-bank-import.service'],['/usr/bin/systemctl','daemon-reload'],
                ['/usr/bin/systemctl','start','aihr-bank-import.service'],['/usr/bin/systemctl','enable','aihr-bank-import.service']])
            directory=self.rolled_back(f,env_bytes,record,'updated')
            stopped=json.loads((directory/'stop-updated'/'activation-failure-observation.json').read_text())
            self.assertTrue(stopped['stopped']);self.assertTrue(stopped['disabled']);self.assertFalse(stopped['forcedKill'])
            self.assertTrue((f.release/'worker-install-v2.json').exists());self.assertTrue((f.operation/'activated.json').exists())
    def test_rollback_with_the_new_web_still_running_uses_the_drain_record_build(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=self.fixture(tmp);env_bytes=f.env.read_bytes();f.drain();f.install_new_web();f.activate()
            record=f.rollback({'web-source':f.source,'web-build':f.build})
            self.assertEqual(record['webSource'],f.source);self.rolled_back(f,env_bytes,record,'updated')
    def test_rollback_after_a_quarantined_activation(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=self.fixture(tmp);env_bytes=f.env.read_bytes();f.drain();f.install_new_web();f.fault='final-web'
            with self.assertRaisesRegex(RuntimeError,'activation failed'):f.activate()
            f.fault=None;f.web['MainPID']='654';before=len(f.mutations())
            record=f.rollback({'web-source':f.source,'web-build':f.build})
            self.assertEqual(f.mutations()[before:],[['/usr/bin/systemctl','daemon-reload'],['/usr/bin/systemctl','start','aihr-bank-import.service'],['/usr/bin/systemctl','enable','aihr-bank-import.service']])
            self.rolled_back(f,env_bytes,record,'updated-quarantined')
    def test_rollback_after_drain_only_restarts_the_unchanged_previous_unit(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=self.fixture(tmp);env_bytes=f.env.read_bytes();f.drain();unit=f.unit.read_bytes();before=len(f.mutations())
            record=f.rollback()
            self.assertEqual(f.mutations()[before:],[['/usr/bin/systemctl','start','aihr-bank-import.service']]);self.assertEqual(f.unit.read_bytes(),unit)
            self.rolled_back(f,env_bytes,record,'previous')
            with self.assertRaisesRegex(ValueError,'already running'):f.rollback()
    def test_rollback_refuses_unpinned_or_unrecorded_state_before_any_change(self):
        defects=['to-unit-pin','unit-pin','unrecorded-web','web-build','writable-release','setuid-release','foreign-unit','no-attempt','other-target','env-pin']
        for defect in defects:
            with self.subTest(defect=defect),tempfile.TemporaryDirectory() as tmp:
                f=self.fixture(tmp);f.drain();f.install_new_web();f.activate();f.roll_web_back();overrides={};before=len(f.mutations())
                unit=f.unit.read_bytes();env_bytes=f.env.read_bytes()
                if defect=='to-unit-pin':overrides['to-unit-sha256']='c'*64
                if defect=='unit-pin':overrides['unit-sha256']='c'*64
                if defect=='unrecorded-web':overrides.update({'web-source':'3'*40})
                if defect=='web-build':overrides['web-build']=f.build
                if defect=='writable-release':(f.previous_release/'package.json').chmod(0o666)
                if defect=='setuid-release':(f.previous_release/'scripts'/'bank-import-runner.ts').chmod(0o4755)
                if defect=='foreign-unit':f.unit.write_text('foreign unit');unit=f.unit.read_bytes()
                if defect=='no-attempt':overrides['from-source']='3'*40
                if defect=='other-target':overrides['to-source']=PRIOR[0]
                if defect=='env-pin':overrides['worker-env-sha256']='d'*64
                with self.assertRaises((ValueError,OSError)):f.rollback(overrides)
                self.assertEqual(f.mutations()[before:],[]);self.assertEqual(f.unit.read_bytes(),unit);self.assertEqual(f.env.read_bytes(),env_bytes)
                self.assertFalse(any(p.name.startswith('rollback-') for p in f.operation.iterdir()))
                self.assertEqual(f.state['WorkingDirectory'],str(f.release) if defect!='foreign-unit' else f.state['WorkingDirectory'])
    def test_rollback_failure_quarantines_the_previous_unit_without_sigkill(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=self.fixture(tmp);env_bytes=f.env.read_bytes();f.drain();f.install_new_web();f.activate();f.roll_web_back();f.fault='env-drift'
            with self.assertRaisesRegex(RuntimeError,'activation failed'):f.rollback()
            self.assertEqual(f.unit.read_bytes(),production.quarantine_unit(f.base,f.previous));self.assertEqual(f.state['MainPID'],'0')
            [directory]=[p for p in f.operation.iterdir() if p.name.startswith('rollback-')]
            observed=json.loads((directory/'activation-failure-observation.json').read_text());self.assertTrue(observed['stopped']);self.assertFalse(observed['forcedKill'])
            self.assert_previous_intact(f,env_bytes)
            # Without new code: a second rollback re-activates the quarantined previous unit once the cause is repaired.
            f.fault=None;record=f.rollback();self.assertEqual(record['fromState'],'previous-quarantined')
            self.assertEqual(f.unit.read_bytes(),install.service_unit(f.previous).encode());self.assertEqual(f.state['ActiveState'],'active')


WORKBOOK_SECRET='fictional-workbook-key-5Tq'
ADDED_KEYS={'MOVEMENT_IMPORT_WORKBOOK_KEY':WORKBOOK_SECRET,'MOVEMENT_IMPORT_WORKBOOK_KEY_ID':'fictional-key-id-1'}

class StagingEnvironmentRebindTests(unittest.TestCase):
    """--previous-worker-env-sha256: a reviewed key was added to the protected environment after the last activation."""
    STAGING={'DATABASE_URL':'postgresql://ai_hr_app:'+APP_SECRET+'@127.0.0.1:5432/ai_hr','MIGRATION_DATABASE_URL':'postgresql://ai_hr_owner:'+OWNER_SECRET+'@127.0.0.1:5432/ai_hr'}
    @staticmethod
    def v2(values):return ''.join(key+'='+json.dumps(values[key],ensure_ascii=False)+'\n' for key in sorted(values))
    def fixture(self,tmp,added=None,raw=None):
        f=UpgradeFlowFixture(Path(tmp));f.base.ENV_KEYS=install.ENV_KEYS;f.base.database_config=install.database_config
        f.env.write_text(self.v2(self.STAGING));f.previous_env_hash=update.digest(f.env.read_bytes())
        f.old_receipt['selectedEnvironmentSha256']=f.previous_env_hash;(f.old_release/'worker-install-v2.json').write_text(json.dumps(f.old_receipt))
        # The operator appends the reviewed keys after the activation that wrote the receipt.
        f.env.write_text(raw if raw is not None else self.v2(self.STAGING)+self.v2(ADDED_KEYS if added is None else added))
        f.env_hash=update.digest(f.env.read_bytes());return f
    def assert_untouched(self,f,error=None):
        self.assertFalse(f.operation.exists());self.assertFalse(any(isinstance(event,list) and 'kill' in event for event in f.events))
        self.assertEqual(f.unit.read_text(),f.service_unit(f.previous_worker));self.assertEqual(json.loads((f.old_release/'worker-install-v2.json').read_text()),f.old_receipt)
        if error is not None:
            text=''.join(traceback.format_exception(error))
            for secret in (APP_SECRET,OWNER_SECRET,WORKBOOK_SECRET):self.assertNotIn(secret,text)
            for key in ADDED_KEYS:self.assertNotIn(key,str(error))
    def test_omitted_argument_keeps_the_drain_record_shape(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=UpgradeFlowFixture(Path(tmp));f.invoke('drain')
            identity=json.loads((f.operation/'drained.json').read_text())['identity'];self.assertNotIn('previous_worker_env_sha256',identity)
            self.assertEqual(len(identity),11);f.web=f.source;f.invoke('activate')
    def test_omitted_argument_with_a_changed_environment_still_refuses(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=self.fixture(tmp)
            with self.assertRaisesRegex(ValueError,'prior managed installation receipt differs') as caught:f.invoke('drain')
            self.assert_untouched(f,caught.exception)
    def test_matching_previous_pin_drains_and_activates_with_the_current_environment_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=self.fixture(tmp);before=f.env.read_bytes();rebind={'previous-worker-env-sha256':f.previous_env_hash}
            f.invoke('drain',rebind)
            identity=json.loads((f.operation/'drained.json').read_text())['identity']
            self.assertEqual(identity['previous_worker_env_sha256'],f.previous_env_hash);self.assertEqual(identity['worker_env_sha256'],f.env_hash)
            self.assertTrue(any(isinstance(event,list) and 'kill' in event for event in f.events))
            f.web=f.source;f.invoke('activate',rebind)
            accepted=json.loads((f.app/'releases'/f.source/'worker-install-v2.json').read_text())
            self.assertEqual(accepted['selectedEnvironmentSha256'],f.env_hash);self.assertEqual(f.env.read_bytes(),before)
            self.assertEqual(f.unit.read_text(),f.service_unit(f.source));self.assertEqual(json.loads((f.old_release/'worker-install-v2.json').read_text()),f.old_receipt)
    def test_wrong_malformed_or_redundant_previous_pin_refuses_before_any_change(self):
        for case in ['wrong','current-as-previous','malformed','short','adopt']:
            with self.subTest(case=case),tempfile.TemporaryDirectory() as tmp:
                f=self.fixture(tmp);phase='drain'
                value={'wrong':'c'*64,'current-as-previous':f.env_hash,'malformed':f.previous_env_hash.upper(),'short':f.previous_env_hash[:63],'adopt':f.previous_env_hash}[case]
                message={'wrong':'receipt differs','current-as-previous':'environment is unchanged','adopt':'not part of adopt-stopped'}.get(case,'digests required')
                overrides={'previous-worker-env-sha256':value}
                if case=='adopt':phase='adopt-stopped';overrides.update({'previous-web-source':None,'previous-web-build':None,'unit-sha256':None,'observed-unit-sha256':f.unit_hash})
                if case=='current-as-previous':f.old_receipt['selectedEnvironmentSha256']=f.env_hash;(f.old_release/'worker-install-v2.json').write_text(json.dumps(f.old_receipt))
                if case=='adopt':
                    # adopt-stopped takes neither the managed pins nor the previous environment pin.
                    original=f.args;f.args=lambda phase,o=None:(lambda argv:argv[:1]+[part for i in range(1,len(argv),2) if argv[i+1] is not None for part in argv[i:i+2]])(original(phase,o))
                with self.assertRaisesRegex(ValueError,message) as caught:f.invoke(phase,overrides)
                self.assert_untouched(f,caught.exception)
    def test_activate_refuses_a_previous_pin_that_differs_from_the_drain_record(self):
        for case in ['omitted','different']:
            with self.subTest(case=case),tempfile.TemporaryDirectory() as tmp:
                f=self.fixture(tmp);f.invoke('drain',{'previous-worker-env-sha256':f.previous_env_hash});f.web=f.source
                overrides={} if case=='omitted' else {'previous-worker-env-sha256':'c'*64}
                with self.assertRaisesRegex(ValueError,'exact drain record required'):f.invoke('activate',overrides)
                self.assertEqual(f.unit.read_text(),f.service_unit(f.previous_worker));self.assertFalse((f.operation/'activated.json').exists())
                self.assertFalse((f.app/'releases'/f.source).exists())
    def test_previous_pin_still_requires_the_reviewed_closed_environment(self):
        cases={'unreviewed-key':(None,self.v2(self.STAGING)+'PORT="3000"\n','unreviewed key'),
               'unquoted-value':(None,self.v2(self.STAGING)+'MOVEMENT_IMPORT_WORKBOOK_KEY='+WORKBOOK_SECRET+'\n','unreviewed syntax'),
               'repeated-key':(None,self.v2(self.STAGING)+self.v2({'DATABASE_URL':self.STAGING['DATABASE_URL']}),'repeats a key'),
               'control-character':(None,self.v2(self.STAGING)+self.v2({'MOVEMENT_IMPORT_WORKBOOK_KEY':WORKBOOK_SECRET+'\u0007'}),'unreviewed value'),
               'remote-database':(None,self.v2({**self.STAGING,'DATABASE_URL':'postgresql://ai_hr_app:'+APP_SECRET+'@db.internal.invalid:5432/ai_hr'})+self.v2(ADDED_KEYS),'approved staging database'),
               'wrong-role':(None,self.v2({**self.STAGING,'MIGRATION_DATABASE_URL':'postgresql://ai_hr_app:'+OWNER_SECRET+'@127.0.0.1:5432/ai_hr'})+self.v2(ADDED_KEYS),'approved staging database'),
               'bad-port':(None,self.v2({**self.STAGING,'DATABASE_URL':'postgresql://ai_hr_app:'+APP_SECRET+'@127.0.0.1:x'+APP_SECRET+'/ai_hr'})+self.v2(ADDED_KEYS),'approved staging database'),
               'missing-database':(None,self.v2({'MIGRATION_DATABASE_URL':self.STAGING['MIGRATION_DATABASE_URL'],**ADDED_KEYS}),'lacks a database URL')}
        for case,(added,raw,message) in cases.items():
            with self.subTest(case=case),tempfile.TemporaryDirectory() as tmp:
                f=self.fixture(tmp,added,raw)
                with self.assertRaisesRegex(ValueError,message) as caught:f.invoke('drain',{'previous-worker-env-sha256':f.previous_env_hash})
                self.assert_untouched(f,caught.exception)

class ProductionEnvironmentRebindTests(unittest.TestCase):
    def fixture(self,tmp,restarted=True):
        f=ProductionUpdateFixture(Path(tmp).resolve());f.previous_env_hash=f.env_hash
        # The operator appends the reviewed keys after the activation that wrote the previous receipt.
        f.values={**f.values,**ADDED_KEYS};f.write_env(f.render(f.values))
        if restarted:f.process('123',f.previous_release)  # The running worker was restarted and loaded the edited file.
        return f
    def rebind(self,f,value=None):return {'previous-worker-env-sha256':value or f.previous_env_hash}
    def assert_no_secret(self,f,error=None):
        texts=[f.stdout,f.stderr]+([''.join(traceback.format_exception(error))] if error is not None else [])
        for text in texts:
            for secret in (APP_SECRET,OWNER_SECRET,WORKBOOK_SECRET):self.assertNotIn(secret,text)
    def assert_refused_before_any_change(self,f,env_bytes,error):
        self.assertEqual(f.mutations(),[]);self.assertEqual(f.signals(),[]);self.assertFalse((f.app/'upgrades').exists());self.assertFalse(f.release.exists())
        self.assertEqual(f.unit.read_bytes(),install.service_unit(f.previous).encode());self.assertEqual(f.state['MainPID'],'123')
        self.assertEqual(f.env.read_bytes(),env_bytes);self.assertEqual(json.loads(f.receipt_path.read_text()),f.previous_receipt);self.assert_no_secret(f,error)
    def test_omitted_argument_with_a_changed_environment_still_refuses(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=self.fixture(tmp);env_bytes=f.env.read_bytes()
            with self.assertRaisesRegex(ValueError,'prior managed installation receipt differs') as caught:f.drain()
            self.assert_refused_before_any_change(f,env_bytes,caught.exception)
    def test_matching_previous_pin_drains_activates_and_the_new_receipt_records_the_current_environment(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=self.fixture(tmp);env_bytes=f.env.read_bytes();f.drain(self.rebind(f))
            record=json.loads((f.operation/'drained.json').read_text())
            self.assertEqual(record['identity']['previous_worker_env_sha256'],f.previous_env_hash);self.assertEqual(record['identity']['worker_env_sha256'],f.env_hash)
            self.assertEqual(f.mutations(),[SIGTERM_DRAIN])
            f.install_new_web();accepted=f.activate(self.rebind(f))
            self.assertEqual(accepted['selectedEnvironmentSha256'],f.env_hash);self.assertEqual(json.loads((f.release/'worker-install-v2.json').read_text()),accepted)
            self.assertEqual(f.env.read_bytes(),env_bytes);self.assertEqual(json.loads(f.receipt_path.read_text()),f.previous_receipt);self.assert_no_secret(f)
            # A later update from the new release needs no previous pin: its receipt records the current environment.
            with patch.object(install,'command',side_effect=f.command):
                _,receipt=production.managed_release(f.base,update,f.source,accepted['unitSha256'],f.env_hash)
            self.assertEqual(receipt,accepted)
    def test_a_worker_still_running_on_the_environment_before_the_edit_refuses(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=self.fixture(tmp,restarted=False);env_bytes=f.env.read_bytes()
            with self.assertRaisesRegex(ValueError,'live worker environment differs') as caught:f.drain(self.rebind(f))
            self.assert_refused_before_any_change(f,env_bytes,caught.exception)
    def test_wrong_malformed_or_redundant_previous_pin_refuses_before_any_change(self):
        for case in ['wrong','current-as-previous','malformed','short']:
            with self.subTest(case=case),tempfile.TemporaryDirectory() as tmp:
                f=self.fixture(tmp);env_bytes=f.env.read_bytes()
                value={'wrong':'c'*64,'current-as-previous':f.env_hash,'malformed':f.previous_env_hash.upper(),'short':f.previous_env_hash[:63]}[case]
                message={'wrong':'receipt differs','current-as-previous':'environment is unchanged'}.get(case,'digests required')
                with self.assertRaisesRegex(ValueError,message) as caught:f.drain(self.rebind(f,value))
                self.assert_refused_before_any_change(f,env_bytes,caught.exception)
    def test_previous_pin_still_requires_the_reviewed_environment(self):
        for case in ['unreviewed-key','plain-remote-database','current-pin']:
            with self.subTest(case=case),tempfile.TemporaryDirectory() as tmp:
                f=self.fixture(tmp);overrides=self.rebind(f)
                if case=='unreviewed-key':f.write_env(f.render(f.values)+'PORT=3000\n')
                if case=='plain-remote-database':f.write_env(f.render({**f.values,'DATABASE_URL':f.values['DATABASE_URL'].replace('?sslmode=verify-full','')}))
                if case=='current-pin':overrides['worker-env-sha256']='d'*64
                env_bytes=f.env.read_bytes()
                with self.assertRaises(ValueError) as caught:f.drain(overrides)
                self.assert_refused_before_any_change(f,env_bytes,caught.exception)
    def test_activate_refuses_a_previous_pin_that_differs_from_the_drain_record(self):
        for case in ['omitted','different']:
            with self.subTest(case=case),tempfile.TemporaryDirectory() as tmp:
                f=self.fixture(tmp);f.drain(self.rebind(f));f.install_new_web()
                overrides={'previous-worker-env-sha256':None} if case=='omitted' else self.rebind(f,'c'*64)
                with self.assertRaisesRegex(ValueError,'exact production drain record required'):f.activate(overrides)
                self.assertEqual(f.unit.read_bytes(),install.service_unit(f.previous).encode());self.assertFalse(f.release.exists())
                self.assertFalse(any(event==['/usr/bin/systemctl','daemon-reload'] for event in f.events));self.assertEqual(f.mutations(),[SIGTERM_DRAIN])
    def test_rollback_accepts_the_recorded_previous_pin_and_refuses_a_mismatch(self):
        for case in ['omitted','different','recorded']:
            with self.subTest(case=case),tempfile.TemporaryDirectory() as tmp:
                f=self.fixture(tmp);env_bytes=f.env.read_bytes();f.drain(self.rebind(f));f.install_new_web();f.activate(self.rebind(f));f.roll_web_back()
                before=len(f.mutations());unit=f.unit.read_bytes()
                if case!='recorded':
                    with self.assertRaisesRegex(ValueError,'drained previous release') as caught:f.rollback({} if case=='omitted' else self.rebind(f,'c'*64))
                    self.assertEqual(f.mutations()[before:],[]);self.assertEqual(f.unit.read_bytes(),unit);self.assert_no_secret(f,caught.exception)
                    self.assertFalse(any(p.name.startswith('rollback-') for p in f.operation.iterdir()));continue
                record=f.rollback(self.rebind(f))
                self.assertEqual(record['fromState'],'updated');self.assertEqual(record['selectedEnvironmentSha256'],f.env_hash)
                self.assertEqual(f.unit.read_bytes(),install.service_unit(f.previous).encode());self.assertEqual(f.state['WorkingDirectory'],str(f.previous_release))
                self.assertEqual(f.state['ActiveState'],'active');self.assertEqual(f.env.read_bytes(),env_bytes)
                self.assertEqual(json.loads(f.receipt_path.read_text()),f.previous_receipt);self.assert_no_secret(f)
                # The re-activated release's receipt still records the earlier environment: a later update pins it again.
                with patch.object(install,'command',side_effect=f.command):
                    _,receipt=production.managed_release(f.base,update,f.previous,f.unit_hash,f.env_hash,f.previous_env_hash)
                self.assertEqual(receipt,f.previous_receipt)
    def test_rollback_of_an_unchanged_environment_update_refuses_a_previous_pin(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=ProductionUpdateFixture(Path(tmp).resolve());f.drain();f.install_new_web();f.activate();f.roll_web_back();before=len(f.mutations())
            # Omitted, the drain record keeps exactly the update pins it had before the argument existed.
            self.assertEqual(sorted(json.loads((f.operation/'drained.json').read_text())['identity']),sorted(n.replace('-','_') for n in production.UPDATE_ARGS))
            with self.assertRaisesRegex(ValueError,'drained previous release'):f.rollback({'previous-worker-env-sha256':'c'*64})
            self.assertEqual(f.mutations()[before:],[])

unittest.main()
