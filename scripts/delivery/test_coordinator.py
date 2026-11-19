import importlib.util
import json
import multiprocessing
import os
from pathlib import Path
import tempfile
import unittest
import uuid

spec=importlib.util.spec_from_file_location('delivery_coordinator',Path(__file__).with_name('coordinator.py'));mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
A='a'*40;B='b'*40;D='d'*64;E='e'*64

def request(action,payload,actor='operator',id=None):return {'id':id or str(uuid.uuid4()),'actor':actor,'action':action,'payload':payload}
def race(path,queue):
    c=mod.Coordinator(mod.open_store(path));queue.put(c.handle(request('claim',{'kinds':['verify'],'seconds':30})))

class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.root.chmod(0o700);self.path=self.root/'state.sqlite';self.now=100
        self.db=mod.open_store(self.path);self.c=mod.Coordinator(self.db,now=lambda:self.now)
    def tearDown(self):self.db.close();self.tmp.cleanup()
    def call(self,action,payload):return self.c.handle(request(action,payload))
    def submit(self,source=A,target='staging'):return self.call('submit',{'source':source,'base':B,'contract':D,'target':target})['release']
    def claim(self,kind):return self.call('claim',{'kinds':[kind],'seconds':30})
    def finish(self,j,result='passed',receipt=None):return self.call('finish',{'job':j['job'],'epoch':j['epoch'],'token':j['token'],'result':result,'receipt':receipt or {'source':j['spec']['source'],'artifactDigest':D}})
    def ready(self):
        rid=self.submit()
        for kind in ['verify','build','prepare']:self.finish(self.claim(kind))
        return rid
    def acquire(self,rid):return self.call('acquire',{'release':rid,'baseline':None,'authorization':{'artifactDigest':D,'target':'staging','receiptDigest':E}})
    def test_duplicate_intent_and_different_intent(self):
        r=request('submit',{'source':A,'base':B,'contract':D,'target':'staging'});a=self.c.handle(r);self.assertEqual(a,self.c.handle(r));r['payload']['contract']=E
        with self.assertRaises(ValueError):self.c.handle(r)
    def test_claim_epoch_fences_crashed_agents(self):
        self.submit();a=self.claim('verify');self.now=131;b=self.claim('verify');self.assertGreater(b['epoch'],a['epoch'])
        with self.assertRaises(ValueError):self.finish(a)
        self.finish(b);self.assertTrue(self.finish(b)['duplicate'])
        with self.assertRaises(ValueError):self.finish(b,receipt={'source':A,'artifactDigest':E})
    def test_dependency_order_and_preparation_outside_lease(self):
        self.submit();self.assertIsNone(self.claim('install')['job']);self.assertIsNone(self.claim('build')['job']);self.finish(self.claim('verify'));self.finish(self.claim('build'));self.finish(self.claim('prepare'));self.assertIsNone(self.claim('install')['job'])
    def test_live_failure_retains_owner_and_cannot_be_stolen_after_expiry(self):
        rid=self.ready();lease=self.acquire(rid);job=self.claim('install');self.now=1000;self.assertIsNone(self.claim('install')['job'])
        with self.assertRaises(ValueError):self.finish(job)
        recovery={k:lease[k] for k in ['target','release','epoch','token']};recovery['receiptDigest']=D;self.assertTrue(self.call('recover',recovery)['leaseRetained']);self.assertGreater(self.claim('install')['epoch'],job['epoch'])
    def test_failed_switch_requires_explicit_recovery_and_keeps_lease(self):
        rid=self.ready();lease=self.acquire(rid);self.finish(self.claim('install'),'failed');self.assertIsNone(self.claim('install')['job']);status=self.call('status',{});self.assertEqual(status['targets'][0]['release_id'],rid)
        with self.assertRaises(ValueError):self.call('supersede',{'release':rid,'replacement':self.submit(B)})
    def test_full_journey_exact_artifact_acceptance_and_redacted_status(self):
        rid=self.ready();lease=self.acquire(rid);self.finish(self.claim('install'));self.finish(self.claim('observe'))
        p={**lease,'source':A,'artifactDigest':D,'receiptDigest':E};p.pop('baseline')
        self.assertEqual(self.call('accept',p)['state'],'accepted');s=self.call('status',{});self.assertIsNone(s['targets'][0]['release_id']);self.assertNotIn(lease['token'],json.dumps(s));self.assertEqual(s['targets'][0]['installed'],A)
    def test_stale_environment_baseline_refuses_without_mutation(self):
        rid=self.ready()
        with self.assertRaises(ValueError):self.call('acquire',{'release':rid,'baseline':B,'authorization':{'artifactDigest':D,'target':'staging','receiptDigest':E}})
        self.assertIsNone(self.call('status',{})['targets'][0]['release_id'])
    def test_multiple_processes_can_only_claim_one_job(self):
        self.submit();q=multiprocessing.Queue();workers=[multiprocessing.Process(target=race,args=(str(self.path),q))for _ in range(4)]
        for w in workers:w.start()
        results=[q.get(timeout=10)for _ in workers]
        for w in workers:w.join(10);self.assertEqual(w.exitcode,0)
        self.assertEqual(sum(r['job']is not None for r in results),1)
    def test_cancel_fences_inflight_builder(self):
        old=self.submit();j=self.claim('verify');new=self.submit(B);self.call('supersede',{'release':old,'replacement':new})
        with self.assertRaises(ValueError):self.finish(j)
    def test_public_or_symlinked_state_is_refused(self):
        p=self.root/'alias';p.symlink_to(self.path)
        with self.assertRaises(ValueError):mod.open_store(p)
        os.chmod(self.path,0o644)
        with self.assertRaises(ValueError):mod.open_store(self.path)
if __name__=='__main__':unittest.main()
