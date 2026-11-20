import json,pathlib,subprocess,sys,tempfile,unittest,zipfile,stat
SCRIPT=pathlib.Path(__file__).with_name('exact-recovery-extract.py')
class ExactExtraction(unittest.TestCase):
    def invoke(self,database=False,extra=(),omit=None,mixed=False,files=None):
        with tempfile.TemporaryDirectory() as root:
            root=pathlib.Path(root);archive=root/'in.zip';destination=root/'out'
            groups={'NODB':[] if database else (files or ['test/a.test.ts']),'DB':(files or ['test/a.test.ts']) if database else []}
            if mixed:groups={'NODB':['test/b.test.ts'],'DB':['test/a.test.ts']}
            members={'focused.json':json.dumps({'groups':groups,'sha':'a'*40,'controller':'c'*40,'runId':'200','attempt':'1','exitCode':0}),('db.vitest.json' if database else 'nodb.vitest.json'):'{}'}
            if database:members.update({'postgres.log':'safe diagnostic','postgres-stats.txt':'{}','postgres-state.json':'{}'})
            with zipfile.ZipFile(archive,'w') as z:
                for n,v in members.items():
                    if n!=omit:z.writestr(n,v)
                for n,v in extra:z.writestr(n,v)
            p=subprocess.run([sys.executable,str(SCRIPT),str(archive),str(destination)],capture_output=True)
            return p.returncode,sorted(x.name for x in destination.iterdir()) if destination.exists() else []
    def test_profile_diagnostics_stay_in_original_zip(self):self.assertEqual(self.invoke(True,extra=[('profile-summary.json','{}'),('harness-profile/profile-123-1.jsonl','{}\n')]),(0,['db.vitest.json','focused.json']))
    def test_profile_on_nodb_refused(self):self.assertNotEqual(self.invoke(extra=[('profile-summary.json','{}')])[0],0)
    def test_profile_traversal_refused(self):self.assertNotEqual(self.invoke(True,extra=[('harness-profile/../../escape.jsonl','{}')])[0],0)
    def test_carry_receipt_declared_by_selected_source(self):
        receipt={'kind':'SEARCHED_CARRY_50000_NATIVE_COMPONENT','status':'COMPLETE','settlement':'CONFIRMED','observedBackends':4}
        self.assertEqual(self.invoke(True,files=['test/analytics-carry-searched-native-scale.test.ts'],extra=[('analytics-carry-searched-native-50k.json',json.dumps(receipt))]),(0,['db.vitest.json','focused.json']))
    def test_sequential_carry_transactions_may_reuse_one_backend(self):
        receipt={'kind':'SEARCHED_CARRY_50000_NATIVE_COMPONENT','status':'COMPLETE','settlement':'CONFIRMED','observedBackends':1}
        self.assertEqual(self.invoke(True,files=['test/analytics-carry-searched-native-scale.test.ts'],extra=[('analytics-carry-searched-native-50k.json',json.dumps(receipt))]),(0,['db.vitest.json','focused.json']))
    def test_carry_backend_count_must_be_one_to_four_unique_connections(self):
        for count in [0,5,-1,True,1.5,'1',None]:
            with self.subTest(count=count):
                receipt={'kind':'SEARCHED_CARRY_50000_NATIVE_COMPONENT','status':'COMPLETE','settlement':'CONFIRMED','observedBackends':count}
                self.assertNotEqual(self.invoke(True,files=['test/analytics-carry-searched-native-scale.test.ts'],extra=[('analytics-carry-searched-native-50k.json',json.dumps(receipt))])[0],0)
    def test_missing_carry_receipt_refused(self):self.assertNotEqual(self.invoke(True,files=['test/analytics-carry-searched-native-scale.test.ts'])[0],0)
    def test_undeclared_carry_refused(self):self.assertNotEqual(self.invoke(True,extra=[('analytics-carry-searched-native-50k.json','{}')])[0],0)
    def test_unsettled_carry_refused(self):
        receipt={'kind':'SEARCHED_CARRY_50000_NATIVE_COMPONENT','status':'INCOMPLETE','settlement':'REFUSED','observedBackends':4}
        self.assertNotEqual(self.invoke(True,files=['test/analytics-carry-searched-native-scale.test.ts'],extra=[('analytics-carry-searched-native-50k.json',json.dumps(receipt))])[0],0)
    def test_selected_source_diagnostic(self):
        value={'kind':'CLAIMS_APPROVAL_QUEUE_SCALE_V1'}
        self.assertEqual(self.invoke(True,files=['test/claims-approval-queue-scale.test.ts'],extra=[('claims-approval-queue-100k.json',json.dumps(value))]),(0,['db.vitest.json','focused.json']))
    def test_undeclared_source_diagnostic(self):self.assertNotEqual(self.invoke(True,extra=[('claims-approval-queue-100k.json','{}')])[0],0)
    def test_source_diagnostic_wrong_kind(self):self.assertNotEqual(self.invoke(True,files=['test/personnel-page-projection.test.ts'],extra=[('personnel-page-projection.json','{}')])[0],0)
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
    def test_screenshot_inventory_of_large_nodb_partition(self):
        screenshots=[('ui-screenshots/page-%d.png'%i,b'PNG') for i in range(328)]
        self.assertEqual(self.invoke(extra=screenshots),(0,['focused.json','nodb.vitest.json']))
        self.assertNotEqual(self.invoke(True,extra=screenshots)[0],0)
        self.assertNotEqual(self.invoke(extra=screenshots+[('ui-screenshots/other-%d.png'%i,b'PNG') for i in range(55)])[0],0)
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
