"""Explicit LIVE issuance from actual completed seal; historical execution authority never changes."""
import copy,json,unittest
from pathlib import Path
from types import ModuleType,SimpleNamespace
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
profile=ModuleType('seal_completion_fixture');profile.__file__=str(ROOT/'test/fixtures/bank-import-worker-recovery-profile-tests.py')
exec(Path(profile.__file__).read_text().rsplit("\nif __name__",1)[0],profile.__dict__)
ci,published,prepared=profile.ci,profile.published,profile.prepared


class SealCompletionTests(unittest.TestCase):
 def authority(self):
  iso=lambda x:ci.datetime.fromtimestamp(x,ci.timezone.utc).isoformat()
  a={'kind':published.KINDS[published.LIVE_STAGE],'recovery':{'policy':ci.UNSTARTED.POLICY},published.BUDGET_KEY:published.BUDGET_PROFILE,published.SEAL_FRESHNESS_KEY:published.SEAL_FRESHNESS_POLICY,'issuedAt':iso(1301)}
  return a,{'issuedAt':iso(1000),'expiresAt':iso(1300)},{'sealedAt':iso(1290)},iso
 def test_new_policy_uses_completed_seal_exact300_boundary_legacy_keeps_original_expiry(self):
  a,authority,record,iso=self.authority();b=SimpleNamespace(check=profile.origin.unstarted_fixture.prior.core.check)
  self.assertEqual(published.validate_seal_window(b,ci,a,authority,record,1290,1301),1590)
  a['issuedAt']=iso(1590);published.validate_seal_window(b,ci,a,authority,record,1290,1590)
  a['issuedAt']=iso(1590.001)
  with self.assertRaisesRegex(ValueError,'freshness window'):published.validate_seal_window(b,ci,a,authority,record,1290,1590.001)
  a['issuedAt']=iso(1301);a.pop(published.SEAL_FRESHNESS_KEY)
  with self.assertRaisesRegex(ValueError,'freshness window'):published.validate_seal_window(b,ci,a,authority,record,1290,1301)
  a['issuedAt']=iso(1300);self.assertEqual(published.validate_seal_window(b,ci,a,authority,record,1290,1300),1300)
 def test_historical_seal_expiry_and_os_mtime_are_never_extended(self):
  for fault in ('sealed-after-expiry','mtime-after','mtime-before','authority-over300','live-before-seal','future-live'):
   with self.subTest(fault=fault):
    a,authority,record,iso=self.authority();mtime=1290;now=1301;b=SimpleNamespace(check=profile.origin.unstarted_fixture.prior.core.check)
    if fault=='sealed-after-expiry':record['sealedAt']=iso(1301)
    elif fault=='mtime-after':mtime=1300.001
    elif fault=='mtime-before':mtime=999.999
    elif fault=='authority-over300':authority['expiresAt']=iso(1301)
    elif fault=='live-before-seal':a['issuedAt']=iso(1289)
    else:now=1300
    with self.assertRaises(ValueError):published.validate_seal_window(b,ci,a,authority,record,mtime,now)
 def test_unknown_policy_or_foreign_kind_origin_budget_and_seal_refuse(self):
  for fault in ('unknown','kind','origin','budget','seal'):
   with self.subTest(fault=fault):
    a,authority,record,iso=self.authority();b=SimpleNamespace(check=profile.origin.unstarted_fixture.prior.core.check);stage=published.LIVE_STAGE
    if fault=='unknown':a[published.SEAL_FRESHNESS_KEY]='unreviewed'
    elif fault=='kind':a['kind']='ADMIN_AUTHORIZED_SINGLE_CI_WORKER_CUTOVER'
    elif fault=='origin':a['recovery']['policy']=prepared.POLICY
    elif fault=='budget':a.pop(published.BUDGET_KEY)
    else:stage=published.SEAL_STAGE
    with self.assertRaises(ValueError):published.budget_fields(b,ci,set(),a,stage)
 def test_near_deadline_completed_real_seal_supports_fresh_live_full_graph_without_history_changes(self):
  f=profile.RecoveryProfileTests.fixture(self);capture=prepared.tree_identity;seen=[]
  def slow(*args,**kwargs):
   if kwargs.get('content')and not seen:seen.append(True);f.clock+=250;f.monotonic_offset+=250
   return capture(*args,**kwargs)
  with patch.object(prepared,'tree_identity',slow):proof=f.seal()
  seal_bytes=proof.read_bytes();seal=json.loads(seal_bytes);seal_authority=Path(seal['approval']).read_bytes();proof_stat=proof.stat();f.clock+=60;f.monotonic_offset=0
  a=f.live(proof);a[published.BUDGET_KEY]=published.BUDGET_PROFILE;a[published.SEAL_FRESHNESS_KEY]=published.SEAL_FRESHNESS_POLICY
  f.invoke_published(published.LIVE_STAGE,a)
  receipt=json.loads((f.app/'releases'/f.source/'worker-install-v2.json').read_bytes());self.assertEqual(receipt[published.SEAL_FRESHNESS_KEY],published.SEAL_FRESHNESS_POLICY);self.assertEqual(receipt[published.BUDGET_KEY],published.BUDGET_PROFILE);self.assertEqual((receipt['fullNativeAudits'],receipt['completeMetadataFences']),(2,10));self.assertEqual(receipt['transitionStages'],['F']*10)
  self.assertEqual(proof.read_bytes(),seal_bytes);self.assertEqual(Path(seal['approval']).read_bytes(),seal_authority);self.assertEqual(proof.stat().st_mtime_ns,proof_stat.st_mtime_ns);self.assertEqual(f.actual_stability_sleeps,[4,4,4])
 def test_original_live_without_policy_refuses_after_original_seal_expiry_before_mutation(self):
  f=profile.RecoveryProfileTests.fixture(self);proof=f.seal();f.clock+=301;a=f.live(proof);a[published.BUDGET_KEY]=published.BUDGET_PROFILE
  with self.assertRaisesRegex(ValueError,'freshness window'):f.invoke_published(published.LIVE_STAGE,a)
  profile.RecoveryProfileTests.unchanged(self,f)


if __name__=='__main__':unittest.main()
