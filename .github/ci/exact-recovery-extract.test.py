import json,pathlib,subprocess,sys,tempfile,unittest,zipfile,stat
SCRIPT=pathlib.Path(__file__).with_name('exact-recovery-extract.py')
class ExactExtraction(unittest.TestCase):
    def invoke(self,database=False,extra=(),omit=None,mixed=False):
        with tempfile.TemporaryDirectory() as root:
            root=pathlib.Path(root);archive=root/'in.zip';destination=root/'out'
            groups={'NODB':[] if database else ['test/a.test.ts'],'DB':['test/a.test.ts'] if database else []}
            if mixed:groups={'NODB':['test/b.test.ts'],'DB':['test/a.test.ts']}
            members={'focused.json':json.dumps({'groups':groups,'sha':'a'*40,'controller':'c'*40,'runId':'200','attempt':'1'}),('db.vitest.json' if database else 'nodb.vitest.json'):'{}'}
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
    def prerequisites(self,**change):
        values=[]
        for name,kind in [('personnel-draft-discard-premigration-role-prerequisites.json','PERSONNEL_DRAFT_DISCARD_PREMIGRATION_ROLE_PREREQUISITES'),('personnel-draft-discard-role-prerequisites.json','PERSONNEL_DRAFT_DISCARD_DISPOSABLE_ROLE_PREREQUISITES')]:
            d={'kind':kind,'candidate':'a'*40,'controller':'c'*40,'runId':'200','attempt':'1'};d.update(change);values.append((name,json.dumps(d)))
        return values
    def test_setup_diagnostics_retained_only_in_original_zip(self):self.assertEqual(self.invoke(True,extra=self.prerequisites()),(0,['db.vitest.json','focused.json']))
    def test_setup_pair_required(self):self.assertNotEqual(self.invoke(True,extra=self.prerequisites()[:1])[0],0)
    def test_setup_refused_without_db(self):self.assertNotEqual(self.invoke(extra=self.prerequisites())[0],0)
    def test_setup_candidate(self):self.assertNotEqual(self.invoke(True,extra=self.prerequisites(candidate='f'*40))[0],0)
    def test_setup_controller(self):self.assertNotEqual(self.invoke(True,extra=self.prerequisites(controller='f'*40))[0],0)
    def test_setup_run(self):self.assertNotEqual(self.invoke(True,extra=self.prerequisites(runId='201'))[0],0)
    def test_setup_attempt(self):self.assertNotEqual(self.invoke(True,extra=self.prerequisites(attempt='2'))[0],0)
    def test_setup_kind(self):self.assertNotEqual(self.invoke(True,extra=self.prerequisites(kind='foreign'))[0],0)
    def test_setup_bound(self):self.assertNotEqual(self.invoke(True,extra=[(self.prerequisites()[0][0],'x'*65537),self.prerequisites()[1]])[0],0)
    def test_setup_invalid_json(self):self.assertNotEqual(self.invoke(True,extra=[(self.prerequisites()[0][0],'{'),self.prerequisites()[1]])[0],0)
    def test_setup_duplicate(self):self.assertNotEqual(self.invoke(True,extra=self.prerequisites()+self.prerequisites()[:1])[0],0)
    def test_symlink(self):
        i=zipfile.ZipInfo('ui-screenshots/link.png');i.create_system=3;i.external_attr=(stat.S_IFLNK|0o777)<<16
        self.assertNotEqual(self.invoke(extra=[(i,b'/etc/passwd')])[0],0)
if __name__=='__main__':unittest.main()
