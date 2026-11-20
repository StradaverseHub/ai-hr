import json,pathlib,subprocess,sys,tempfile,unittest,zipfile,stat
SCRIPT=pathlib.Path(__file__).with_name('focused-recovery-extract.py')
class FocusedExtraction(unittest.TestCase):
    def invoke(self,extra=(),missing=None,database=False):
        with tempfile.TemporaryDirectory() as root:
            root=pathlib.Path(root);archive=root/'in.zip';destination=root/'out'
            with zipfile.ZipFile(archive,'w') as z:
                result='db.vitest.json' if database else 'nodb.vitest.json'
                report=json.dumps({'groups':{'DB':['test/db.test.ts'] if database else [],'NODB':[] if database else ['test/plain.test.ts']}})
                for name in ['focused.json',result]:
                    if name!=missing:z.writestr(name,report if name=='focused.json' else '{}')
                if database:
                    for name in ['postgres.log','postgres-state.json','postgres-stats.txt']:z.writestr(name,'{}')
                for name,data in extra:z.writestr(name,data)
            r=subprocess.run([sys.executable,str(SCRIPT),str(archive),str(destination)],capture_output=True)
            return r.returncode,sorted(p.name for p in destination.iterdir()) if destination.exists() else []
    def test_required_json_only(self):self.assertEqual(self.invoke(),(0,['focused.json','nodb.vitest.json']))
    def test_screenshots_retained_in_archive_not_extracted(self):self.assertEqual(self.invoke([('ui-screenshots/en-pay-rule-mobile.png',b'PNG'),('ui-screenshots/en-pay-rule.json','{}')]),(0,['focused.json','nodb.vitest.json']))
    def test_missing_report(self):self.assertNotEqual(self.invoke(missing='focused.json')[0],0)
    def test_missing_results(self):self.assertNotEqual(self.invoke(missing='nodb.vitest.json')[0],0)
    def test_traversal(self):self.assertNotEqual(self.invoke([('../escape.json','{}')])[0],0)
    def test_screenshot_traversal(self):self.assertNotEqual(self.invoke([('ui-screenshots/../escape.png',b'x')])[0],0)
    def test_unknown_json(self):self.assertNotEqual(self.invoke([('injected.json','{}')])[0],0)
    def test_unknown_binary(self):self.assertNotEqual(self.invoke([('ui-screenshots/code.sh',b'exit')])[0],0)
    def test_duplicate(self):self.assertNotEqual(self.invoke([('focused.json','{}')])[0],0)
    def test_backslash(self):self.assertNotEqual(self.invoke([('ui-screenshots\\escape.png',b'x')])[0],0)
    def test_database_packet(self):self.assertEqual(self.invoke(database=True),(0,['db.vitest.json','focused.json']))
    def test_database_role_receipt(self):
        name='personnel-draft-discard-premigration-role-prerequisites.json'
        self.assertEqual(self.invoke([(name,'{}')],database=True),(0,['db.vitest.json','focused.json',name]))
    def test_nodb_cannot_include_database_diagnostics(self):self.assertNotEqual(self.invoke([('postgres.log','{}')])[0],0)
    def test_database_cannot_include_nodb_result(self):self.assertNotEqual(self.invoke([('nodb.vitest.json','{}')],database=True)[0],0)
    def test_symlink(self):
        info=zipfile.ZipInfo('ui-screenshots/link.png');info.create_system=3;info.external_attr=(stat.S_IFLNK|0o777)<<16
        self.assertNotEqual(self.invoke([(info,b'/etc/passwd')])[0],0)
    def test_member_count(self):self.assertNotEqual(self.invoke([(f'ui-screenshots/{i}.json','{}') for i in range(129)])[0],0)
if __name__=='__main__':unittest.main()
