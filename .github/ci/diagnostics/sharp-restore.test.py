"""Tiny private filesystem fixtures only; no application/database/build execution."""
import base64,hashlib,json,os,pathlib,runpy,tempfile,unittest
D=pathlib.Path(__file__).resolve().parent
S=runpy.run_path(str(D/'sharp-restore.py'));M=S['M'];clean=(D/'sharp-clean-semver.fixture').read_bytes()
class Restore(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.source=pathlib.Path(self.tmp.name)/'source';self.modules=self.source/'node_modules';self.target=self.modules/'.pnpm/sharp@0.35.5/node_modules/sharp';self.parent=self.target/'node_modules/.bin';self.parent.mkdir(parents=True)
  self.shim=self.parent/'semver';self.shim.write_bytes(S['exact_host_bytes'](clean,self.source));self.shim.chmod(0o755)
  (self.target/'package.json').write_text('{"name":"sharp","version":"0.35.5"}')
  self.semver=self.modules/'.pnpm/semver@7.8.5/node_modules/semver';self.semver.mkdir(parents=True);(self.semver/'bin').mkdir();(self.semver/'bin/semver.js').write_text('locked fixture')
  (self.target.parent/'semver').symlink_to(self.semver,target_is_directory=True);(self.modules/'sharp').symlink_to(self.target,target_is_directory=True)
  self.ci=self.inventory();self.original=self.shim.read_bytes().replace(b'../../../../../semver@7.8.5/node_modules/semver/bin/semver.js',b'../../../semver/bin/semver.js');self.shim.write_bytes(self.original);self.old=self.inventory();self.backup=pathlib.Path(self.tmp.name)/'backup';self.authority=lambda:{'fresh':'exact'}
 def inventory(self):
  desc,_=M['package_identity'](self.source,'sharp',producer_source=S['PRODUCER']);rows=[]
  for p in sorted(self.target.rglob('*')):
   if p.is_file():
    b=p.read_bytes();rel=p.relative_to(self.target).as_posix()
    if rel=='node_modules/.bin/semver':b=M['rebase_installer_shim'](b,self.source,S['PRODUCER'])
    rows.append({'path':rel,'size':len(b),'sha256':S['digest'](b)})
  return {'descriptor':desc,'rows':rows,'shim':{'rawBase64':base64.b64encode(clean).decode(),'rawSha256':S['digest'](self.shim.read_bytes())}}
 def invoke(self,**kwargs):return S['restore'](self.source,self.ci,self.old,self.backup,self.authority,**kwargs)
 def test_preview_preserves_all_bytes(self):
  self.assertFalse(self.invoke()['written']);self.assertEqual(self.shim.read_bytes(),self.original);self.assertFalse(self.backup.exists())
 def test_exact_original_full_hash_restored(self):
  result=self.invoke(apply=True);self.assertEqual(result['completePackage'],self.ci['descriptor']);self.assertEqual((self.backup/'semver.original').read_bytes(),self.original);self.assertEqual(self.shim.stat().st_mode&511,0o755)
 def test_preexisting_temp_preserved(self):
  temp=self.parent/'semver.ci-restore-temporary';temp.write_text('another owner');
  with self.assertRaises(FileExistsError):self.invoke(apply=True)
  self.assertEqual(temp.read_text(),'another owner');self.assertEqual(self.shim.read_bytes(),self.original)
 def test_postwrite_context_failure_restores_original(self):
  calls=[]
  def changed():calls.append(1);return {'fresh':'changed' if len(calls)==3 else 'exact'}
  self.authority=changed
  with self.assertRaisesRegex(AssertionError,'after restoration'):self.invoke(apply=True)
  self.assertEqual(self.shim.read_bytes(),self.original);self.assertEqual(self.inventory()['descriptor'],self.old['descriptor']);self.assertTrue((self.backup/'restoration-failed.json').exists())
 def test_prewrite_context_change_preserves_original(self):
  calls=[]
  def changed():calls.append(1);return len(calls)
  self.authority=changed
  with self.assertRaisesRegex(AssertionError,'context changed'):self.invoke(apply=True)
  self.assertEqual(self.shim.read_bytes(),self.original);self.assertFalse((self.parent/'semver.ci-restore-temporary').exists())
 def test_symlink_shim_refuses(self):
  self.shim.unlink();self.shim.symlink_to(self.semver/'bin/semver.js')
  with self.assertRaises(Exception):self.invoke(apply=True)
  self.assertTrue(self.shim.is_symlink())
 def test_wrong_file_mode_refuses(self):
  self.shim.chmod(0o644)
  with self.assertRaises(AssertionError):self.invoke(apply=True)
  self.assertEqual(self.shim.read_bytes(),self.original)
 def test_unrelated_package_change_refuses(self):
  (self.target/'package.json').write_text('{"name":"sharp","version":"0.35.4"}')
  with self.assertRaises(Exception):self.invoke(apply=True)
  self.assertEqual(self.shim.read_bytes(),self.original)
 def test_changed_ci_bytes_refuse(self):
  self.ci['shim']['rawBase64']=base64.b64encode(clean+b'\n').decode()
  with self.assertRaisesRegex(AssertionError,'authenticated CI'):self.invoke(apply=True)
  self.assertEqual(self.shim.read_bytes(),self.original)
 def test_different_semver_target_refuses(self):
  (self.target.parent/'semver').unlink();(self.target.parent/'semver/bin').mkdir(parents=True);(self.target.parent/'semver/bin/semver.js').write_text('different')
  with self.assertRaisesRegex(AssertionError,'same locked dependency'):self.invoke(apply=True)
  self.assertEqual(self.shim.read_bytes(),self.original)
if __name__=='__main__':unittest.main(verbosity=2)
