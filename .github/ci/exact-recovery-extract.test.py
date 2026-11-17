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
    def test_missing_carry_receipt_refused(self):self.assertNotEqual(self.invoke(True,files=['test/analytics-carry-searched-native-scale.test.ts'])[0],0)
    def test_undeclared_carry_refused(self):self.assertNotEqual(self.invoke(True,extra=[('analytics-carry-searched-native-50k.json','{}')])[0],0)
    def test_unsettled_carry_refused(self):
        receipt={'kind':'SEARCHED_CARRY_50000_NATIVE_COMPONENT','status':'INCOMPLETE','settlement':'REFUSED','observedBackends':4}
        self.assertNotEqual(self.invoke(True,files=['test/analytics-carry-searched-native-scale.test.ts'],extra=[('analytics-carry-searched-native-50k.json',json.dumps(receipt))])[0],0)
    def test_selected_source_diagnostic(self):
        value={'kind':'CLAIMS_APPROVAL_QUEUE_SCALE_V1'}
        self.assertEqual(self.invoke(True,files=['test/claims-approval-queue-scale.test.ts'],extra=[('claims-approval-queue-100k.json',json.dumps(value))]),(0,['db.vitest.json','focused.json']))
    def test_label_diagnostics_stay_in_original_zip(self):
        extra=[('system-label-browser-results.json',json.dumps({'source':'a'*40})),('system-label-browser-resources.json','{}'),('system-label-browser-server.log','log'),('system-label-dev-server-heap/heap-123.json','{}'),('system-label-exchange-zh-mobile.png',b'PNG'),('system-label-profile-options-empty.png',b'PNG')]
        self.assertEqual(self.invoke(True,files=['test/system-label-exchange-browser.test.ts'],extra=extra),(0,['db.vitest.json','focused.json']))
    def test_label_undeclared_refused(self):self.assertNotEqual(self.invoke(True,extra=[('system-label-browser-server.log','log')])[0],0)
    def test_label_nodb_refused(self):self.assertNotEqual(self.invoke(files=['test/system-label-exchange-browser.test.ts'],extra=[('system-label-browser-server.log','log')])[0],0)
    def test_label_source_refused(self):self.assertNotEqual(self.invoke(True,files=['test/system-label-exchange-browser.test.ts'],extra=[('system-label-browser-results.json',json.dumps({'source':'f'*40}))])[0],0)
    def test_label_json_bound(self):self.assertNotEqual(self.invoke(True,files=['test/system-label-exchange-browser.test.ts'],extra=[('system-label-browser-resources.json','x'*65537)])[0],0)
    def test_label_unknown_locale_refused(self):self.assertNotEqual(self.invoke(True,files=['test/system-label-exchange-browser.test.ts'],extra=[('system-label-exchange-fr-mobile.png',b'PNG')])[0],0)
    def test_label_traversal_refused(self):self.assertNotEqual(self.invoke(True,files=['test/system-label-exchange-browser.test.ts'],extra=[('system-label-dev-server-heap/../heap-123.json','{}')])[0],0)
    def test_chat_root_diagnostic(self):self.assertEqual(self.invoke(True,files=['test/assistant-chat-list-root-batch.test.ts'],extra=[('assistant-chat-list-root-batch.json',json.dumps({'kind':'NATIVE_CHAT_ROOT_READ_COUNT_COMPONENT_ONLY'}))]),(0,['db.vitest.json','focused.json']))
    def transfer(self,**change):
        value={'kind':'PERSONNEL_DRAFT_DISCARD_RESTRICTED_LOGIN_OWNERSHIP_REHEARSAL','candidate':'a'*40,'controller':'c'*40,'runId':'200','attempt':'1'};value.update(change)
        return [('personnel-draft-discard-role-transfer.json',json.dumps(value))]
    def test_role_transfer_diagnostic(self):self.assertEqual(self.invoke(True,files=['test/personnel-draft-discard-role-transfer.test.ts'],extra=self.transfer()),(0,['db.vitest.json','focused.json']))
    def test_role_transfer_identity(self):
        for key in ['candidate','controller','runId','attempt']:
            with self.subTest(key=key):self.assertNotEqual(self.invoke(True,files=['test/personnel-draft-discard-role-transfer.test.ts'],extra=self.transfer(**{key:'foreign'}))[0],0)
    def test_role_transfer_undeclared(self):self.assertNotEqual(self.invoke(True,extra=self.transfer())[0],0)
    def test_chat_root_undeclared(self):self.assertNotEqual(self.invoke(True,extra=[('assistant-chat-list-root-batch.json',json.dumps({'kind':'NATIVE_CHAT_ROOT_READ_COUNT_COMPONENT_ONLY'}))])[0],0)
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
