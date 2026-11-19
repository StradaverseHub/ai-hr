import hashlib
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import unittest
import uuid
spec=importlib.util.spec_from_file_location('seal',Path(__file__).with_name('seal.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class SealTests(unittest.TestCase):
    def setUp(self):
        self.assertEqual(os.getuid(),0,'Hosted privilege-boundary controls must run through sudo')
        self.base=Path('/var/lib')/('aihr-delivery-qualification-'+str(uuid.uuid4()));self.base.mkdir(mode=0o755);self.root=self.base/'release';self.root.mkdir(mode=0o755);(self.root/'server.js').write_text('fixture; no server or provider request\n');os.chmod(self.root/'server.js',0o644)
    def tearDown(self):shutil.rmtree(self.base)
    def expected(self):return hashlib.sha256(m.canonical(m.inspect_tree(self.root,0))).hexdigest()
    def test_sealed_tree_verifies_without_walking_or_hashing_again(self):
        h=self.expected();a=m.prepare(self.root,h);original=m.inspect_tree;m.inspect_tree=lambda *_:self.fail('Live cutover repeated recursive verification')
        try:self.assertEqual(m.verify(self.root,h),a)
        finally:m.inspect_tree=original
    def test_actual_application_identity_cannot_write_sealed_tree_or_seal(self):
        h=self.expected();m.prepare(self.root,h)
        for p in [self.root/'server.js',self.root/'.delivery-seal.json']:
            r=subprocess.run(['runuser','-u','nobody','--','sh','-c','printf hacked > "$1"','sh',str(p)],capture_output=True)
            self.assertNotEqual(r.returncode,0)
        self.assertEqual(m.verify(self.root,h)['treeDigest'],h)
    def test_wrong_artifact_digest_and_unprotected_ancestor_refuse(self):
        with self.assertRaises(ValueError):m.prepare(self.root,'a'*64)
        os.chmod(self.base,0o777)
        with self.assertRaises(ValueError):self.expected()
    def test_escaping_symlink_and_hardlink_refuse(self):
        (self.root/'escape').symlink_to('/etc/passwd')
        with self.assertRaises(ValueError):self.expected()
        (self.root/'escape').unlink();os.link(self.root/'server.js',self.root/'alias')
        with self.assertRaises(ValueError):self.expected()
    def test_root_identity_replacement_and_wrong_owner_refuse(self):
        h=self.expected();m.prepare(self.root,h);other=self.base/'other';self.root.rename(other);self.root.mkdir(mode=0o555);shutil.copyfile(other/'.delivery-seal.json',self.root/'.delivery-seal.json');os.chmod(self.root/'.delivery-seal.json',0o444)
        with self.assertRaises(ValueError):m.verify(self.root,h)
    def test_existing_seal_and_writable_member_refuse_preparation(self):
        os.chmod(self.root/'server.js',0o666)
        with self.assertRaises(ValueError):self.expected()
if __name__=='__main__':unittest.main()
