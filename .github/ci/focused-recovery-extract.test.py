import pathlib,subprocess,sys,tempfile,unittest,zipfile,stat
SCRIPT=pathlib.Path(__file__).with_name('focused-recovery-extract.py')
class FocusedExtraction(unittest.TestCase):
    def invoke(self,extra=(),missing=None):
        with tempfile.TemporaryDirectory() as root:
            root=pathlib.Path(root);archive=root/'in.zip';destination=root/'out'
            with zipfile.ZipFile(archive,'w') as z:
                for name in ['focused.json','nodb.vitest.json']:
                    if name!=missing:z.writestr(name,'{}')
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
    def test_symlink(self):
        info=zipfile.ZipInfo('ui-screenshots/link.png');info.create_system=3;info.external_attr=(stat.S_IFLNK|0o777)<<16
        self.assertNotEqual(self.invoke([(info,b'/etc/passwd')])[0],0)
    def test_member_count(self):self.assertNotEqual(self.invoke([(f'ui-screenshots/{i}.json','{}') for i in range(129)])[0],0)
if __name__=='__main__':unittest.main()
