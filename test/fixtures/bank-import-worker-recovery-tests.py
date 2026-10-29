import sys
sys.dont_write_bytecode=True
import hashlib
import importlib.util
from pathlib import Path
import os
import tempfile
from types import SimpleNamespace
import unittest

ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,ROOT/path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
fmt=load('worker_format','deploy/systemd/bank_import_worker_format.py')
install=load('worker_install','deploy/systemd/bank_import_worker_installer_v2.py')
recovery=load('worker_recovery','deploy/systemd/bank_import_worker_recovery.py')

class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        payload={'package.json':b'{}','pnpm-lock.yaml':b'lock','tsconfig.json':b'{}','scripts/bank-import-runner.ts':b'fixture','node_modules/tsx/package.json':b'{}'};entries={}
        for name,raw in payload.items():
            path=self.root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(raw);os.chmod(path,0o644)
            entries[name]={'path':name,'type':'file','mode':0o644,'size':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
            for parent in Path(name).parents:
                if str(parent)!='.': entries[str(parent)]={'path':str(parent),'type':'directory'}
        self.manifest={'format':1,'kind':'bank-import-worker-package-v1','source':'1'*40,'runtime':fmt.RUNTIME.copy(),'lockSha256':fmt.digest(payload['pnpm-lock.yaml']),'packageSha256':fmt.digest(payload['package.json']),'entries':[entries[k] for k in sorted(entries)]}
        # These tests exercise real inventory/byte/mode verification without a privileged install.
        # Root path ownership itself is covered by the installer refusal cases.
        self.ops=SimpleNamespace(check=install.check,root_protected=lambda *a,**k:None,validate_command_proofs=install.validate_command_proofs)
    def tearDown(self): self.temp.cleanup()
    def test_exact_tree_passes_and_unknown_extra_bytes_refuse(self):
        recovery.verify_existing_tree(self.root,self.manifest,fmt,self.ops)
        (self.root/'extra').write_text('unreviewed')
        with self.assertRaisesRegex(ValueError,'extra entries'): recovery.verify_existing_tree(self.root,self.manifest,fmt,self.ops)
    def test_modified_bytes_with_same_size_refuse(self):
        (self.root/'package.json').write_bytes(b'[]')
        with self.assertRaisesRegex(ValueError,'bytes differ'): recovery.verify_existing_tree(self.root,self.manifest,fmt,self.ops)
    def test_changed_mode_or_missing_runtime_input_refuses(self):
        path=self.root/'package.json';os.chmod(path,0o666)
        with self.assertRaisesRegex(ValueError,'mode/size'): recovery.verify_existing_tree(self.root,self.manifest,fmt,self.ops)
        os.chmod(path,0o644);path.unlink()
        with self.assertRaisesRegex(ValueError,'missing or extra'): recovery.verify_existing_tree(self.root,self.manifest,fmt,self.ops)
    def test_continuation_refuses_active_enabled_or_previously_started_worker(self):
        commands={key:{'type':'a(sasbttttuii)','data':[]} for key in ['ExecStartPre','ExecStartPost','ExecStop','ExecStopPost','ExecCondition']}
        commands['ExecStart']={'type':'a(sasbttttuii)','data':[[str(install.NODE),[str(install.NODE),'--import','tsx','scripts/bank-import-runner.ts'],False,0,0,0,0,0,0,0]]}
        properties={'ActiveState':'inactive','SubState':'dead','MainPID':'0','NRestarts':'0','UnitFileState':'disabled','_commands':commands}
        recovery.never_started(properties,self.ops)
        for key,value in [('ActiveState','active'),('MainPID','123'),('UnitFileState','enabled'),('NRestarts','1')]:
            with self.assertRaises(ValueError): recovery.never_started({**properties,key:value},self.ops)
        commands['ExecStart']['data'][0][3]=1
        with self.assertRaisesRegex(ValueError,'already executed'): recovery.never_started(properties,self.ops)
    def identities(self):
        identity=SimpleNamespace(pw_name='aihr-import',pw_uid=900,pw_gid=900)
        groups=[SimpleNamespace(gr_name='aihr-import',gr_gid=900,gr_mem=[])]
        return identity,[identity],groups,SimpleNamespace(USER='aihr-import',check=install.check)
    def test_duplicate_uid_or_other_primary_gid_owner_refuses(self):
        identity,people,groups,ops=self.identities();recovery.validate_identity(identity,people,groups,ops)
        with self.assertRaisesRegex(ValueError,'UID is not unique'):
            recovery.validate_identity(identity,people+[SimpleNamespace(pw_name='alias',pw_uid=900,pw_gid=901)],groups,ops)
        with self.assertRaisesRegex(ValueError,'another primary owner'):
            recovery.validate_identity(identity,people+[SimpleNamespace(pw_name='other',pw_uid=901,pw_gid=900)],groups,ops)
    def test_foreign_group_members_aliases_and_worker_supplementary_group_refuse(self):
        identity,people,groups,ops=self.identities()
        for bad in [[SimpleNamespace(gr_name='aihr-import',gr_gid=900,gr_mem=['other'])],groups+[SimpleNamespace(gr_name='alias',gr_gid=900,gr_mem=[])],groups+[SimpleNamespace(gr_name='admin',gr_gid=901,gr_mem=['aihr-import'])]]:
            with self.assertRaises(ValueError): recovery.validate_identity(identity,people,bad,ops)

unittest.main()
