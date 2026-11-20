import json,pathlib,subprocess,sys,tempfile,unittest,zipfile,stat
SCRIPT=pathlib.Path(__file__).with_name('focused-recovery-extract.py')
class FocusedExtraction(unittest.TestCase):
    def invoke(self,extra=(),missing=None,database=False,visual=False):
        with tempfile.TemporaryDirectory() as root:
            root=pathlib.Path(root);archive=root/'in.zip';destination=root/'out'
            with zipfile.ZipFile(archive,'w') as z:
                result='db.vitest.json' if database else 'nodb.vitest.json'
                db_file='test/operational-visual-browser.test.ts' if visual else 'test/db.test.ts'
                files=[db_file] if database else ['test/plain.test.ts']
                report=json.dumps({'files':files,'groups':{'DB':files if database else [],'NODB':[] if database else files}})
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
        runtime='personnel-draft-discard-role-prerequisites.json'
        self.assertEqual(self.invoke([(name,'{}'),(runtime,'{}')],database=True),(0,['db.vitest.json','focused.json',name,runtime]))
    def test_incomplete_role_receipts(self):self.assertNotEqual(self.invoke([('personnel-draft-discard-premigration-role-prerequisites.json','{}')],database=True)[0],0)
    def test_nodb_cannot_include_database_diagnostics(self):self.assertNotEqual(self.invoke([('postgres.log','{}')])[0],0)
    def test_database_cannot_include_nodb_result(self):self.assertNotEqual(self.invoke([('nodb.vitest.json','{}')],database=True)[0],0)
    def test_symlink(self):
        info=zipfile.ZipInfo('ui-screenshots/link.png');info.create_system=3;info.external_attr=(stat.S_IFLNK|0o777)<<16
        self.assertNotEqual(self.invoke([(info,b'/etc/passwd')])[0],0)
    def test_measured_nodb_screenshot_inventory_is_not_extracted(self):
        screens=[(f'ui-screenshots/{i}.{extension}',b'fixture') for i in range(156) for extension in ('png','json')]
        self.assertEqual(self.invoke(screens),(0,['focused.json','nodb.vitest.json']))
    def test_member_count(self):self.assertNotEqual(self.invoke([(f'ui-screenshots/{i}.json','{}') for i in range(385)])[0],0)
    def test_database_member_count(self):self.assertNotEqual(self.invoke([(f'ui-screenshots/{i}.json','{}') for i in range(129)],database=True)[0],0)
    def test_visual_requires_every_screenshot_and_keeps_images_in_archive(self):
        routes=('admin-settings-system-labels','roster','rewards','admin-personnel','attendance-daily',
                'payroll','me','claims','approvals','leave','leave-employee-balances','leave-employee-records',
                'reports','reports-employee-master-new','recruitment','analytics','admin-settings-people','today',
                'label-guidance')
        header=b'\x89PNG\r\n\x1a\n'
        screens=[(f'operational-{route}-{device}.png',header) for route in routes for device in ('desktop','mobile')]
        proofs=[('operational-authenticated-visual-results.json','{}'),('operational-overflow-results.json','{}'),
                ('operational-visual-progress.json','{}')]
        self.assertEqual(self.invoke(screens+proofs,database=True,visual=True),(0,[
            'db.vitest.json','focused.json','operational-authenticated-visual-results.json','operational-overflow-results.json']))
        self.assertNotEqual(self.invoke(screens[1:]+proofs,database=True,visual=True)[0],0)
        invalid=[(screens[0][0],b'not a PNG')]+screens[1:]+proofs
        self.assertNotEqual(self.invoke(invalid,database=True,visual=True)[0],0)
        self.assertNotEqual(self.invoke(screens+proofs,database=True)[0],0)
if __name__=='__main__':unittest.main()
