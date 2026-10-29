import hashlib
import sys
sys.dont_write_bytecode=True
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

spec=importlib.util.spec_from_file_location('worker_installer',Path(__file__).resolve().parents[2]/'deploy/systemd/bank_import_worker_installer_v2.py')
install=importlib.util.module_from_spec(spec);spec.loader.exec_module(install)

class WorkerInstallerTests(unittest.TestCase):
    def test_service_is_fixed_nonroot_and_cannot_take_unit_text_or_source_injection(self):
        unit=install.service_unit('1'*40)
        self.assertIn('User=aihr-import\nGroup=aihr-import\n',unit)
        self.assertIn('ExecStart=/opt/node22/bin/node --import tsx scripts/bank-import-runner.ts\n',unit)
        self.assertNotIn('ExecStartPre',unit);self.assertNotIn('User=root',unit)
        for source in ['1'*40+'\nUser=root','/etc/passwd','1'*39]:
            with self.assertRaises(ValueError): install.service_unit(source)
    def test_database_identity_is_local_distinct_and_does_not_allow_libpq_options(self):
        config=install.database_config('postgresql://ai_hr_app:fictional@127.0.0.1:5432/ai_hr','ai_hr_app')
        self.assertEqual({k:config[k] for k in ('PGUSER','PGHOST','PGPORT','PGDATABASE')},{'PGUSER':'ai_hr_app','PGHOST':'127.0.0.1','PGPORT':'5432','PGDATABASE':'ai_hr'})
        for uri in ['postgresql://ai_hr_owner:fictional@127.0.0.1/ai_hr','postgresql://ai_hr_app:fictional@attacker.example/ai_hr','postgresql://ai_hr_app:fictional@127.0.0.1/other','postgresql://ai_hr_app:fictional@127.0.0.1/ai_hr?options=arbitrary','postgresql://ai_hr_app:fictional@127.0.0.1/ai_hr?sslmode=require&sslmode=disable']:
            with self.assertRaises(ValueError): install.database_config(uri,'ai_hr_app')
    def test_hash_pins_private_snapshot_and_does_not_reopen_mutable_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);source=root/'incoming';snapshot=root/'snapshot';source.write_bytes(b'authentic bytes')
            install.snapshot_archive(source,snapshot,hashlib.sha256(b'authentic bytes').hexdigest(),100)
            source.write_bytes(b'changed later')
            self.assertEqual(snapshot.read_bytes(),b'authentic bytes')
            with self.assertRaises(ValueError): install.snapshot_archive(source,root/'bad','0'*64,100)
            with self.assertRaises(FileExistsError): install.snapshot_archive(source,snapshot,'0'*64,100)
    def test_refuses_symlink_and_writable_ancestor_for_privileged_binary(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);link=root/'node';link.symlink_to('/usr/bin/python3')
            with self.assertRaises(ValueError): install.root_protected(link,regular=True)
            file=root/'plain';file.write_text('fixture')
            with self.assertRaises(ValueError): install.root_protected(file,regular=True)
    def test_rejects_service_override_before_start(self):
        release=Path('/opt/aihr-import/releases/'+'1'*40)
        properties={'User':'aihr-import','Group':'aihr-import','WorkingDirectory':str(release),'FragmentPath':str(install.UNIT),'Environment':'NODE_ENV=production','EnvironmentFiles':str(install.ENV)+' (ignore_errors=no)'}
        for key in ['DropInPaths','ExecStartPre','ExecStartPost','ExecStop','ExecStopPost','ExecCondition','PassEnvironment','RootDirectory','RootImage','PAMName']: properties[key]=''
        install.validate_service(properties,release)
        for key,value in [('User','root'),('DropInPaths','/unreviewed.conf'),('ExecStartPre','+/bin/sh malicious')]:
            wrong={**properties,key:value}
            with self.assertRaises(ValueError): install.validate_service(wrong,release)
    def test_cleanup_disables_and_confirms_even_after_stop_timeout(self):
        calls=[]
        def run(argv,**kwargs):
            calls.append(argv)
            if 'stop' in argv: raise TimeoutError('fictional stop timeout')
            if 'disable' in argv: return SimpleNamespace(returncode=0,stdout='')
            return SimpleNamespace(returncode=0,stdout='ActiveState=inactive\nMainPID=0\nUnitFileState=disabled\n')
        with patch.object(install,'command',side_effect=run):
            self.assertEqual(install.stop_owned_first_install(),{'stopped':True,'disabled':True,'requestWarnings':['stop request unavailable']})
        self.assertEqual([args[1] for args in calls],['stop','disable','show'])
    def test_cleanup_never_claims_success_when_worker_still_running(self):
        def run(argv,**kwargs): return SimpleNamespace(returncode=0,stdout='ActiveState=active\nMainPID=123\nUnitFileState=disabled\n')
        with patch.object(install,'command',side_effect=run),patch.object(install.time,'monotonic',side_effect=[0,0,331]),patch.object(install.time,'sleep'):
            with self.assertRaisesRegex(RuntimeError,'could not confirm'): install.stop_owned_first_install()

unittest.main()
