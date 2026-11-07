"""Managed update refusal controls. No root operations, live services, credentials or DBs."""
import sys
sys.dont_write_bytecode=True
import hashlib
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

unittest.main()
