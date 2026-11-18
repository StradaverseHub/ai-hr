import json,pathlib,subprocess,sys,tempfile,unittest,zipfile,stat
SCRIPT=pathlib.Path(__file__).with_name('repair-recovery-extract.py')
class RepairExtraction(unittest.TestCase):
    def invoke(self,database=False,extra=(),omit=None,mixed=False,compatibility=False):
        with tempfile.TemporaryDirectory() as root:
            root=pathlib.Path(root);archive=root/'in.zip';destination=root/'out'
            groups={'NODB':[] if database else ['test/a.test.ts'],'DB':['test/a.test.ts'] if database else []}
            if mixed:groups={'NODB':['test/b.test.ts'],'DB':['test/a.test.ts']}
            members={'focused.json':json.dumps({'groups':groups,'files':['test/ai-review-worker-compatibility.test.ts'] if compatibility else groups['DB']+groups['NODB'],'sha':'d'*40}),('db.vitest.json' if database else 'nodb.vitest.json'):'{}'}
            if database:members.update({'postgres.log':'safe diagnostic','postgres-stats.txt':'{}','postgres-state.json':'{}'})
            with zipfile.ZipFile(archive,'w') as z:
                for n,v in members.items():
                    if n!=omit:z.writestr(n,v)
                for n,v in extra:z.writestr(n,v)
            p=subprocess.run([sys.executable,str(SCRIPT),str(archive),str(destination)],capture_output=True)
            return p.returncode,sorted(x.name for x in destination.iterdir()) if destination.exists() else []
    def worker_pair(self):
        common={'kind':'GIT_SOURCE_CROSS_VERSION_FIXTURE_NOT_PACKET_OR_LIVE_ACCEPTANCE','webSource':'d'*40,'reviewedHistoricalBaseline':'a4bd903840cdae2a94e67d5f57e3b54c9e2a86ac','matchingWorkerRequired':True,'authenticatedCorrectedPacketProofRequired':True,'actualPacketExecuted':False,'protectedServiceVerified':False,'liveRestartVerified':False,'deploymentAuthorized':False,'newWebAdmission':True,'humanCommandFixture':True,'canonicalWrite':True,'tenantDenial':True,'newProcessReplay':True,'historyItems':1,'schemaEntries':1069,'sourceArchiveSha256':'a'*64}
        return [(name,json.dumps({**common,'workerSource':source})) for name,source in [('worker-cross-version-legacy.json','968354c00a71df7baccd499eb60757a3307ed61e'),('worker-cross-version-staged.json','a4bd903840cdae2a94e67d5f57e3b54c9e2a86ac')]]
    def test_worker_pair_original_only(self):self.assertEqual(self.invoke(True,extra=self.worker_pair(),compatibility=True),(0,['db.vitest.json','focused.json']))
    def test_worker_pair_foreign_selection(self):self.assertNotEqual(self.invoke(True,extra=self.worker_pair())[0],0)
    def test_worker_pair_nodb(self):self.assertNotEqual(self.invoke(extra=self.worker_pair(),compatibility=True)[0],0)
    def test_worker_pair_missing(self):self.assertNotEqual(self.invoke(True,extra=self.worker_pair()[:1],compatibility=True)[0],0)
    def test_worker_pair_both_missing(self):self.assertNotEqual(self.invoke(True,compatibility=True)[0],0)
    def test_worker_pair_bad_identity(self):
        extra=self.worker_pair();extra[0]=(extra[0][0],extra[0][1].replace('d'*40,'e'*40));self.assertNotEqual(self.invoke(True,extra=extra,compatibility=True)[0],0)
    def test_worker_pair_overclaims(self):
        extra=self.worker_pair();payload=json.loads(extra[0][1]);payload['actualPacketExecuted']=True;extra[0]=(extra[0][0],json.dumps(payload));self.assertNotEqual(self.invoke(True,extra=extra,compatibility=True)[0],0)
    def test_worker_pair_oversize(self):self.assertNotEqual(self.invoke(True,extra=[('worker-cross-version-legacy.json','x'*(32*1024+1)),self.worker_pair()[1]],compatibility=True)[0],0)
    def test_worker_pair_invalid_json(self):self.assertNotEqual(self.invoke(True,extra=[('worker-cross-version-legacy.json','not json'),self.worker_pair()[1]],compatibility=True)[0],0)
    def test_worker_pair_exact_bound(self):
        extra=self.worker_pair();name,value=extra[0];extra[0]=(name,value+' '*(32*1024-len(value)));self.assertEqual(self.invoke(True,extra=extra,compatibility=True)[0],0)
    def test_unknown_worker_name(self):self.assertNotEqual(self.invoke(True,extra=[('worker-cross-version-other.json','{}')])[0],0)
    def test_nodb(self):self.assertEqual(self.invoke(),(0,['focused.json','nodb.vitest.json']))
    def test_db_diagnostics_not_extracted(self):self.assertEqual(self.invoke(True),(0,['db.vitest.json','focused.json']))
    def test_role_diagnostics_remain_in_original_db_zip(self):
        extra=[(n,'{}') for n in ['personnel-draft-discard-premigration-role-prerequisites.json','personnel-draft-discard-role-prerequisites.json']]
        self.assertEqual(self.invoke(True,extra=extra),(0,['db.vitest.json','focused.json']))
    def test_role_diagnostic_bound(self):
        self.assertNotEqual(self.invoke(True,extra=[('personnel-draft-discard-role-prerequisites.json','x'*(32*1024+1))])[0],0)
    def test_role_diagnostic_nodb_refused(self):
        self.assertNotEqual(self.invoke(extra=[('personnel-draft-discard-role-prerequisites.json','{}')])[0],0)
    def test_unknown_role_diagnostic_refused(self):
        self.assertNotEqual(self.invoke(True,extra=[('personnel-draft-discard-unknown-role-prerequisites.json','{}')])[0],0)
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
