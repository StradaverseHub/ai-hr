"""Closed recovery-only scheduling allocation: unchanged finite authority, proof graph and total reserve."""
import copy,json,unittest
from pathlib import Path
from types import ModuleType,SimpleNamespace
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
origin=ModuleType('profile_origin_fixture');origin.__file__=str(ROOT/'test/fixtures/bank-import-worker-published-unstarted-tests.py')
exec(Path(origin.__file__).read_text().rsplit("\nif __name__",1)[0],origin.__dict__)
ci,published,prepared=origin.ci,origin.published,origin.prepared


class RecoveryProfileTests(unittest.TestCase):
 def fixture(self):
  f=origin.PublishedUnstartedTests.fixture(self,legacy=True);old_sleep=f.sleep_port;f.actual_stability_sleeps=[]
  def elapsed_sleep(seconds):
   if seconds==4:f.actual_stability_sleeps.append(seconds);f.monotonic_offset+=seconds;f.clock+=seconds
   return old_sleep(seconds)
  f.sleep_port=elapsed_sleep;return f
 def live(self,f):
  proof=f.seal();a=f.live(proof);a[published.BUDGET_KEY]=published.BUDGET_PROFILE;return a
 def unchanged(self,f):origin.PublishedUnstartedTests.unchanged(self,f)
 def test_explicit_profile_runs_entire_proof_graph_and_receipt_matches_authority(self):
  f=self.fixture();a=self.live(f);slots=[];actual=ci.RuntimeObservation.slot
  def observe(o,name,seconds):slots.append((name,seconds));return actual(o,name,seconds)
  with patch.object(ci.RuntimeObservation,'slot',observe):f.invoke_published(published.LIVE_STAGE,a)
  receipt=json.loads((f.app/'releases'/f.source/'worker-install-v2.json').read_bytes())
  self.assertEqual(receipt[published.BUDGET_KEY],published.BUDGET_PROFILE);self.assertEqual((receipt['fullNativeAudits'],receipt['completeMetadataFences']),(2,10));self.assertEqual(receipt['transitionStages'],['F']*10)
  for pair in [('F4',30),('W/F1',30),('W/F2',30),('W/F3',30),('F8',26),('F9',26)]:self.assertIn(pair,slots)
  self.assertEqual(sum(1 for name,seconds in slots if name.startswith('W/F')),3)
  self.assertEqual(f.actual_stability_sleeps,[4,4,4])
 def test_profile_is_closed_and_never_admitted_to_seal_normal_or_other_origin(self):
  for fault in ('unknown','seal','kind','origin'):
   with self.subTest(fault=fault):
    f=self.fixture()
    if fault=='seal':
     a=f.seal_record();a[published.BUDGET_KEY]=published.BUDGET_PROFILE
     with self.assertRaises(ValueError):f.invoke_published(published.SEAL_STAGE,a)
    else:
     a=self.live(f)
     if fault=='unknown':a[published.BUDGET_KEY]='unreviewed'
     elif fault=='kind':a['kind']='ADMIN_AUTHORIZED_SINGLE_CI_WORKER_CUTOVER'
     else:a['recovery']['policy']=prepared.POLICY
     with self.assertRaises(ValueError):f.invoke_published(published.LIVE_STAGE,a)
    self.unchanged(f)
 def test_allocation_is_constant_budget_and_legacy_normal_ceilings_are_unchanged(self):
  b=SimpleNamespace(check=origin.unstarted_fixture.prior.core.check)
  o=SimpleNamespace(base=b,guard=SimpleNamespace(ci=ci,stage=published.LIVE_STAGE),auth={'kind':published.KINDS[published.LIVE_STAGE],'recovery':{'policy':ci.UNSTARTED.POLICY},published.BUDGET_KEY:published.BUDGET_PROFILE})
  self.assertEqual(published.selected_budget(o),{'F4':30,'stability':30,'F8':26,'F9':26});self.assertEqual(published.post_opportunity(o,40),537);self.assertEqual(published.post_opportunity(o,40)+30,567)
  o.auth.pop(published.BUDGET_KEY);self.assertIsNone(published.selected_budget(o));self.assertEqual(published.post_opportunity(o,40),537)
  o.guard.stage='activate-prepared-ci-runtime';self.assertEqual(ci.RuntimeObservation.stability_seconds(o),24)
  source=(ROOT/'deploy/systemd/bank_import_worker_ci_runtime_v1.py').read_text();self.assertIn('estimated_normal=830',source);self.assertIn("original=json.loads(b.read_bounded(self.directory/'runtime.json'",source)
 def test_unchanged_post537_authority567_floors_refuse_before_unit_mutation(self):
  admit=ci.RuntimeObservation.admit_mutation
  for fault in ('global','authority'):
   with self.subTest(fault=fault):
    f=self.fixture();a=self.live(f)
    def insufficient(o):
     if fault=='global':f.monotonic_offset+=o.overall_deadline-ci.time.monotonic()-536
     else:f.clock=ci.epoch(o.auth['expiresAt'])-566
     return admit(o)
    with patch.object(ci.RuntimeObservation,'admit_mutation',insufficient):
     with self.assertRaisesRegex(ValueError,'insufficient independently authorized'):f.invoke_published(published.LIVE_STAGE,a)
    self.unchanged(f)
 def test_finite_profile_boundaries_quarantine_rejected_owned_worker(self):
  for slot,delay,accepted in [('F4',29,True),('F4',31,False),('F5',25,True),('F5',27,False),('F8',25,True),('F8',27,False),('F9',25,True),('F9',27,False)]:
   with self.subTest(slot=slot,delay=delay):
    f=self.fixture();a=self.live(f);seen=[];capture=origin.unstarted_fixture.prior.core.fences.capture_tree
    def delayed(*args,**kwargs):
     observer=ci.ACTIVE_OPERATION_GUARD.observer
     if observer.slot_name==slot and not seen:seen.append(True);f.monotonic_offset+=delay
     return capture(*args,**kwargs)
    with patch.object(origin.unstarted_fixture.prior.core.fences,'capture_tree',delayed):
     if accepted:f.invoke_published(published.LIVE_STAGE,a)
     else:
      with self.assertRaisesRegex(RuntimeError,'explicit administrator recovery'):f.invoke_published(published.LIVE_STAGE,a)
      self.assertEqual(f.report['MainPID'],'0');self.assertEqual(f.report['UnitFileState'],'disabled');self.assertFalse((f.app/'releases'/f.source/'worker-install-v2.json').exists())
    self.assertEqual(seen,[True])
 def test_profile_cannot_extend_root_expiry_global_cap_or_native_freshness(self):
  f=self.fixture();a=self.live(f);a['expiresAt']=f.iso(-1)
  with self.assertRaises(ValueError):f.invoke_published(published.LIVE_STAGE,a)
  self.unchanged(f)
  f=self.fixture();a=self.live(f)
  with patch.object(f.base,'RECOVERY_OVERALL_DEADLINE',ci.time.monotonic()-1,create=True):
   with self.assertRaises(ValueError):f.invoke_published(published.LIVE_STAGE,a)
  self.unchanged(f)
  now=1794874000;base=SimpleNamespace(check=origin.unstarted_fixture.prior.core.check);stamp=ci.datetime.fromtimestamp(now-61,ci.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
  with self.assertRaisesRegex(ValueError,'stale'):ci.native_timestamp(base,stamp,now-3600,now,fresh=True)


if __name__=='__main__':unittest.main()
