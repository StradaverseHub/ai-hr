import json,pathlib,subprocess,sys,tempfile,unittest,zipfile,stat
SCRIPT=pathlib.Path(__file__).with_name('repair-recovery-extract.py')
class RepairExtraction(unittest.TestCase):
    def invoke(self,database=False,extra=(),omit=None,mixed=False):
        with tempfile.TemporaryDirectory() as root:
            root=pathlib.Path(root);archive=root/'in.zip';destination=root/'out'
            groups={'NODB':[] if database else ['test/a.test.ts'],'DB':['test/a.test.ts'] if database else []}
            if mixed:groups={'NODB':['test/b.test.ts'],'DB':['test/a.test.ts']}
            members={'focused.json':json.dumps({'groups':groups}),('db.vitest.json' if database else 'nodb.vitest.json'):'{}'}
            if database:members.update({'postgres.log':'safe diagnostic','postgres-stats.txt':'{}','postgres-state.json':'{}'})
            with zipfile.ZipFile(archive,'w') as z:
                for n,v in members.items():
                    if n!=omit:z.writestr(n,v)
                for n,v in extra:z.writestr(n,v)
            p=subprocess.run([sys.executable,str(SCRIPT),str(archive),str(destination)],capture_output=True)
            return p.returncode,sorted(x.name for x in destination.iterdir()) if destination.exists() else []
    def test_nodb(self):self.assertEqual(self.invoke(),(0,['focused.json','nodb.vitest.json']))
    def test_db_diagnostics_not_extracted(self):self.assertEqual(self.invoke(True),(0,['db.vitest.json','focused.json']))
    def test_mixed_refused(self):self.assertNotEqual(self.invoke(mixed=True)[0],0)
    def test_missing_db_diagnostic(self):self.assertNotEqual(self.invoke(True,omit='postgres-stats.txt')[0],0)
    def test_missing_result(self):self.assertNotEqual(self.invoke(True,omit='db.vitest.json')[0],0)
    def test_wrong_result(self):self.assertNotEqual(self.invoke(extra=[('db.vitest.json','{}')])[0],0)
    def test_foreign(self):self.assertNotEqual(self.invoke(extra=[('unknown.json','{}')])[0],0)
    def test_traversal(self):self.assertNotEqual(self.invoke(extra=[('../escape.json','{}')])[0],0)
    def test_nodb_db_diagnostic(self):self.assertNotEqual(self.invoke(extra=[('postgres.log','x')])[0],0)
    def test_duplicate(self):self.assertNotEqual(self.invoke(extra=[('focused.json','{}')])[0],0)
    def test_screenshot(self):self.assertEqual(self.invoke(extra=[('ui-screenshots/page.png',b'PNG')])[0],0)
    def test_symlink(self):
        i=zipfile.ZipInfo('ui-screenshots/link.png');i.create_system=3;i.external_attr=(stat.S_IFLNK|0o777)<<16
        self.assertNotEqual(self.invoke(extra=[(i,b'/etc/passwd')])[0],0)
if __name__=='__main__':unittest.main()
