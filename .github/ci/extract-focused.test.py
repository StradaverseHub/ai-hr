import importlib.util,pathlib,subprocess,tempfile,unittest,zipfile,stat,sys
SCRIPT=pathlib.Path(__file__).with_name('extract-focused.py')
class FocusedExtraction(unittest.TestCase):
 def check(self,entries,ok):
  with tempfile.TemporaryDirectory() as t:
   p=pathlib.Path(t);archive=p/'a.zip'
   with zipfile.ZipFile(archive,'w') as z:
    for name,data in entries:z.writestr(name,data)
   r=subprocess.run([sys.executable,str(SCRIPT),str(archive),str(p/'out')],capture_output=True)
   self.assertEqual(r.returncode==0,ok)
   if ok:self.assertEqual(sorted(x.name for x in (p/'out').iterdir()),['focused.json'])
 def test_diagnostics_retained_only_in_zip(self):self.check([('focused.json','{}'),('postgres.log','private diagnostic')],True)
 def test_traversal(self):self.check([('focused.json','{}'),('../escape','x')],False)
 def test_duplicate(self):self.check([('focused.json','{}'),('focused.json','{}')],False)
 def test_missing(self):self.check([('postgres.log','x')],False)
 def test_malformed_json(self):self.check([('focused.json','not JSON')],False)
if __name__=='__main__':unittest.main()
