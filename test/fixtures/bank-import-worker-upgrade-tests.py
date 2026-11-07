"""Managed update refusal controls. No root operations, live services, credentials or DBs."""
import sys
sys.dont_write_bytecode=True
import hashlib
import json
import os
from contextlib import ExitStack
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
    def test_bundle_is_self_contained_and_does_not_load_mutable_web_modules(self):
        with tempfile.TemporaryDirectory() as tmp:
            output=Path(tmp)/'helper.py'
            result=subprocess.run([sys.executable,'-I','-B',str(ROOT/'scripts/bank-import-worker-upgrade-bundle.py'),str(output)],capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            body=output.read_text();self.assertNotIn('spec_from_file_location',body)
            self.assertIn('types.ModuleType',body);self.assertEqual(output.stat().st_mode&0o777,0o600)
            result=subprocess.run([sys.executable,'-I','-B',str(output),'--help'],capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr);self.assertIn('previous-source',result.stdout)
            duplicate=subprocess.run([sys.executable,'-I','-B',str(ROOT/'scripts/bank-import-worker-upgrade-bundle.py'),str(output)],capture_output=True,text=True)
            self.assertNotEqual(duplicate.returncode,0)

class UpgradeFlowFixture:
    """Real temporary files; deterministic systemd/proc/privilege adapters only."""
    def __init__(self,root):
        self.root=root;self.events=[];self.fault=None;self.used_fault=False
        self.previous='1'*40;self.source='2'*40;self.old_build='old-build';self.new_build='new-build';self.web=self.previous
        self.app=root/'app';self.app.mkdir();(self.app/'releases').mkdir()
        self.unit=root/'worker.service';self.env=root/'worker.env';self.env.write_bytes(b'DATABASE_URL="fictional"\n')
        self.archive=root/'package.zip';self.archive.write_bytes(b'authenticated fictional archive')
        self.node=root/'node';self.node.write_text('fictional')
        self.old_release=self.app/'releases'/self.previous;self.old_release.mkdir()
        self.report={'MainPID':'123','ActiveState':'active','SubState':'running','NRestarts':'0','Result':'success','ExecMainStatus':'0','Restart':'on-failure','SendSIGKILL':'yes','NeedDaemonReload':'no','UnitFileState':'enabled'}
        self.base=SimpleNamespace(ROOT=self.app,NODE=self.node,UNIT=self.unit,ENV=self.env,USER='fictional',check=check,command=self.command,
            root_protected=self.protected,read_bounded=lambda p,limit:p.read_bytes(),service_unit=self.service_unit,
            deployment_state=self.deployment,validate_service=lambda *_:None,write_new=self.write_new,
            install_lock_directory=lambda:root,snapshot_archive=self.snapshot)
        self.unit.write_text(self.service_unit(self.previous))
        self.unit_hash=update.digest(self.unit.read_bytes());self.env_hash=update.digest(self.env.read_bytes())
        self.old_receipt={'source':self.previous,'unitSha256':self.unit_hash,'selectedEnvironmentSha256':self.env_hash,'serviceStable':True}
        (self.old_release/'worker-install-v2.json').write_text(json.dumps(self.old_receipt))
        self.manifest={'entries':[{'path':'package.json','type':'file','mode':0o644}]}
        canonical=lambda value:json.dumps(value,sort_keys=True,separators=(',',':')).encode()
        self.fmt=SimpleNamespace(MAX_ARCHIVE=1024,canonical=canonical,digest=update.digest,extract_archive=self.extract,inspect_archive=lambda *_:self.manifest)
    def service_unit(self,source):return 'WorkingDirectory='+str(self.app/'releases'/source)+'\nRestart=on-failure\n'
    def protected(self,path,regular=False):
        check(Path(path).is_relative_to(self.root) and Path(path).exists() and not Path(path).is_symlink(),'unsafe fixture path')
        if regular:check(Path(path).is_file(),'fixture regular file required')
    def deployment(self,source,build):
        check(source==self.web and build==(self.old_build if source==self.previous else self.new_build),'web identity differs')
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
        self.events.append('extract');(Path(destination)/'package.json').write_text('fictional package');return self.manifest
    def command(self,argv):
        self.events.append(list(argv))
        if argv==[str(self.node),'--version']:return SimpleNamespace(stdout='v22.23.3\n')
        if 'daemon-reload' in argv:
            if self.fault=='reload' and not self.used_fault:self.used_fault=True;raise OSError('fictional reload failure')
            quarantine='SendSIGKILL=no' in self.unit.read_text()
            self.report.update(Restart='no' if quarantine else 'on-failure',SendSIGKILL='no' if quarantine else 'yes',NeedDaemonReload='no')
        elif 'kill' in argv:self.report.update(MainPID='0',ActiveState='inactive',SubState='dead')
        elif 'start' in argv:
            self.report.update(MainPID='456',ActiveState='active',SubState='running')
            if self.fault=='start':raise OSError('fictional start command failure after launch')
            if self.fault=='restart':self.report['NRestarts']='1'
        elif 'disable' in argv:self.report['UnitFileState']='disabled'
        elif 'stop' in argv:
            check(self.report['SendSIGKILL']=='no' and self.report['Restart']=='no','timed stop lacks protection')
            self.report.update(MainPID='0',ActiveState='inactive',SubState='dead')
        return SimpleNamespace(stdout='',returncode=0)
    def args(self,phase):
        values={'previous-source':self.previous,'previous-build':self.old_build,'source':self.source,'build-id':self.new_build,'archive':str(self.archive),'archive-sha256':update.digest(self.archive.read_bytes()),'lock-sha256':'a'*64,'package-sha256':'b'*64,'unit-sha256':self.unit_hash,'worker-env-sha256':self.env_hash}
        return [phase,*[part for key,value in values.items() for part in ('--'+key,value)]]
    def invoke(self,phase):
        original_fstat=os.fstat
        def root_lock(fd):
            info=original_fstat(fd);return SimpleNamespace(st_mode=info.st_mode,st_uid=0,st_nlink=info.st_nlink)
        with ExitStack() as stack:
            stack.enter_context(patch.object(update.os,'geteuid',return_value=0))
            stack.enter_context(patch.object(update.os,'fstat',side_effect=root_lock))
            stack.enter_context(patch.object(update,'properties',side_effect=lambda _:dict(self.report)))
            stack.enter_context(patch.object(update,'validate_process',side_effect=lambda _,report,source:int(report['MainPID'])))
            stack.enter_context(patch.object(update.time,'sleep'))
            update.upgrade(self.args(phase),self.fmt,self.base)
    @property
    def operation(self):return self.app/'upgrades'/self.source

class WorkerUpgradeFlowTests(unittest.TestCase):
    def test_complete_drain_and_activation_preserves_old_release_and_private_environment(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=UpgradeFlowFixture(Path(tmp));before=f.env.read_bytes();f.invoke('drain')
            term=next(i for i,event in enumerate(f.events) if isinstance(event,list) and 'kill' in event)
            self.assertLess(f.events.index('authenticate-archive'),term);self.assertLess(f.events.index('extract'),term)
            self.assertEqual(f.unit.read_text(),f.service_unit(f.previous));f.web=f.source;f.invoke('activate')
            self.assertTrue(f.old_release.is_dir());self.assertEqual(f.env.read_bytes(),before)
            record=json.loads((f.operation/'activated.json').read_text());self.assertEqual(record['workerPid'],456);self.assertFalse(record['journeyVerified'])
            self.assertEqual(f.unit.read_text(),f.service_unit(f.source));self.assertEqual(f.report['ActiveState'],'active')
    def test_bad_archive_refuses_before_signalling_or_unit_mutation(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=UpgradeFlowFixture(Path(tmp));f.base.snapshot_archive=lambda *_:check(False,'archive digest differs')
            with self.assertRaisesRegex(ValueError,'archive digest'):f.invoke('drain')
            self.assertFalse(any(isinstance(event,list) and 'kill' in event for event in f.events));self.assertEqual(f.unit.read_text(),f.service_unit(f.previous))
    def test_previous_receipt_and_environment_mismatch_refuse_before_drain(self):
        for defect in ['receipt','environment']:
            with self.subTest(defect=defect),tempfile.TemporaryDirectory() as tmp:
                f=UpgradeFlowFixture(Path(tmp))
                if defect=='receipt':(f.old_release/'worker-install-v2.json').write_text('{}')
                else:f.env.write_text('changed')
                with self.assertRaises(ValueError):f.invoke('drain')
                self.assertFalse(f.operation.exists());self.assertFalse(any(isinstance(event,list) and 'kill' in event for event in f.events))
    def test_activate_refuses_wrong_web_or_drain_record_before_unit_change(self):
        for defect in ['web','drain']:
            with self.subTest(defect=defect),tempfile.TemporaryDirectory() as tmp:
                f=UpgradeFlowFixture(Path(tmp));f.invoke('drain')
                if defect=='drain':
                    record=json.loads((f.operation/'drained.json').read_text());record['identity']['build_id']='foreign';(f.operation/'drained.json').write_text(json.dumps(record));f.web=f.source
                with self.assertRaises(ValueError):f.invoke('activate')
                self.assertEqual(f.unit.read_text(),f.service_unit(f.previous));self.assertFalse((f.operation/'activated.json').exists())
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
    def test_quarantine_refuses_foreign_unit_without_signalling_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=UpgradeFlowFixture(Path(tmp));f.operation.mkdir(parents=True);f.unit.write_text('foreign unit')
            observed=update.quiesce_failed_activation(f.base,f.operation,f.source)
            self.assertFalse(observed['stopped']);self.assertTrue(observed['quiescenceUnconfirmed']);self.assertEqual(f.events,[])
            self.assertEqual(f.unit.read_text(),'foreign unit')
    def test_failed_quarantine_reload_never_arms_an_unprotected_stop(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=UpgradeFlowFixture(Path(tmp));f.operation.mkdir(parents=True);f.unit.write_text(f.service_unit(f.source));f.fault='reload'
            observed=update.quiesce_failed_activation(f.base,f.operation,f.source)
            self.assertFalse(observed['stopped']);self.assertTrue(observed['quiescenceUnconfirmed'])
            self.assertFalse(any(isinstance(event,list) and 'stop' in event for event in f.events))

unittest.main()
