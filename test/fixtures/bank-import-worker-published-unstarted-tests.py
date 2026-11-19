"""Exact rejected-F5 unstarted lineage through published seal and the unchanged full recovery graph."""
import copy,json,os,tempfile,unittest
from pathlib import Path
from types import ModuleType
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
published_fixture=ModuleType('published_origin_fixture');published_fixture.__file__=str(ROOT/'test/fixtures/bank-import-worker-published-tests.py')
exec(Path(published_fixture.__file__).read_text().rsplit("\nunittest.main(",1)[0],published_fixture.__dict__)
unstarted_fixture=ModuleType('unstarted_origin_fixture');unstarted_fixture.__file__=str(ROOT/'test/fixtures/bank-import-worker-unstarted-tests.py')
exec(Path(unstarted_fixture.__file__).read_text().rsplit("\nif __name__",1)[0],unstarted_fixture.__dict__)
# Both fixtures must exercise ONE actual module graph, not different independently loaded globals.
ci,prepared,guard,update=unstarted_fixture.ci,unstarted_fixture.prepared,unstarted_fixture.guard,unstarted_fixture.update
published=unstarted_fixture.prior.core.load_native('published_unstarted_owner','bank_import_worker_published_v1.py');published.configure(ci,prepared);ci.PUBLISHED=published
published_fixture.ci=ci;published_fixture.prepared=prepared;published_fixture.guard=guard;published_fixture.update=update;published_fixture.published=published


class Fixture(unstarted_fixture.prior.Fixture):
 def command(self,argv,**options):
  if argv==['/usr/bin/systemctl','enable','aihr-bank-import.service']:self.report['UnitFileState']='enabled'
  return super().command(argv,**options)
 seal_record=published_fixture.Fixture.seal_record
 def invoke_published(self,stage,a):
  original=ci.RuntimeObservation.failure_summary;observed=[]
  def retain_cause(observer,error):
   # Fictional fixture diagnostics only. Preserve the real native summary and quarantine behavior.
   observed.append(type(error).__name__+': '+str(error));return original(observer,error)
  with patch.object(ci.RuntimeObservation,'failure_summary',retain_cause):
   try:return published_fixture.Fixture.invoke_published(self,stage,a)
   except RuntimeError as error:raise RuntimeError(str(error)+'; fixture original cause: '+repr(observed))from error
 seal=published_fixture.Fixture.seal
 live=published_fixture.Fixture.live


class PublishedUnstartedTests(unittest.TestCase):
 def fixture(self,legacy=False):
  f,p,proof,a=unstarted_fixture.UnstartedTests.fixture(self,legacy=legacy,expired=True);f.__class__=Fixture;f.base.command=f.command;f.report['ExecMainCode']='0'
  self.assertIs(f.base.command.__self__,f);self.assertIs(f.base.command.__func__,Fixture.command)
  original=ci.RuntimeObservation.complete_fence
  def fail(o,*args,**kwargs):
   if o.fence_count==5:
    # Exact metadata failure under the existing shared24s F5 budget; no synthetic accepted receipt.
    o.slot_name='F5';f.monotonic_offset+=max(0,ci.SLOT_DEADLINE-ci.time.monotonic())
    raise ValueError('Complete metadata fence refused: absolute monotonic deadline exceeded')
   return original(o,*args,**kwargs)
  with patch.object(ci.RuntimeObservation,'complete_fence',fail):
   with self.assertRaisesRegex(RuntimeError,'explicit administrator recovery'):unstarted_fixture.UnstartedTests.invoke(self,f,a)
  f.monotonic_offset=0;operation=f.operation/('unstarted-recovery-'+a['recovery']['id'])
  for path in operation.iterdir():os.utime(path,(f.clock,f.clock));f.additional_root_private_files.add(path)
  f.old=a;f.oldpath=f.root/'live-unstarted.json';release=f.app/'releases'/f.source
  f.pins={'originPolicy':ci.UNSTARTED.POLICY,'approval':str(f.oldpath),'approvalSha256':ci.sha(f.oldpath.read_bytes()),'operation':str(operation),'operationIdentity':published.identity(operation),'members':{path.name:{**published.identity(path),'sha256':ci.sha(path.read_bytes())}for path in operation.iterdir()},'releaseIdentity':published.identity(release),'unitSha256':ci.sha(f.unit.read_bytes())}
  f.clock+=1;f.events=[];return f
 def unchanged(self,f):
  self.assertFalse(any(type(x)is list and len(x)>1 and x[0]=='/usr/bin/systemctl'and x[1]in('start','stop','daemon-reload','disable','enable')for x in f.events));self.assertFalse((f.app/'releases'/f.source/'worker-install-v2.json').exists())
 def test_exact_f5_normal_preparation_and_legacy_baseline_seal_then_full_graph(self):
  for legacy in (False,True):
   with self.subTest(legacy=legacy):
    f=self.fixture(legacy);before=copy.deepcopy(f.pins);oldgrant=(f.directory/'authorization.json').read_bytes();failed=(f.state/'current').read_bytes()
    proof=f.seal();self.unchanged(f)
    with patch.object(prepared.os,'rename',side_effect=AssertionError('Published worker must not be renamed')):f.invoke_published(published.LIVE_STAGE,f.live(proof))
    r=json.loads((f.app/'releases'/f.source/'worker-install-v2.json').read_bytes());self.assertTrue(r['serviceStable']);self.assertEqual((r['fullNativeAudits'],r['completeMetadataFences']),(2,10));self.assertEqual(r['transitionStages'],['F']*10)
    self.assertEqual(f.pins,before);self.assertEqual((f.directory/'authorization.json').read_bytes(),oldgrant);self.assertEqual((f.state/'current').read_bytes(),failed)
 def test_wrong_origin_authority_policy_stage_or_recovery_is_refused(self):
  for fault in ('origin','kind','policy','recovery','stage'):
   with self.subTest(fault=fault):
    f=self.fixture();path=f.oldpath;old=json.loads(path.read_bytes())
    if fault=='origin':f.pins['originPolicy']='unknown'
    elif fault=='kind':old['kind']=prepared.KINDS['recover-ci-runtime']
    elif fault=='policy':old['policy']='unknown'
    elif fault=='recovery':old['recovery']['policy']='unknown'
    else:
     p=Path(f.pins['operation'])/'activation-failure-observation.json';v=json.loads(p.read_bytes());v['failure']['slot']='F4';p.chmod(0o600);p.write_bytes(unstarted_fixture.prior.encoded(v));p.chmod(0o400);os.utime(p,(f.clock,f.clock));f.pins['members'][p.name]={**published.identity(p),'sha256':ci.sha(p.read_bytes())};f.pins['operationIdentity']=published.identity(p.parent)
    if fault in ('kind','policy','recovery'):path.write_bytes(unstarted_fixture.prior.encoded(old));f.pins['approvalSha256']=ci.sha(path.read_bytes())
    with self.assertRaises((ValueError,KeyError)):f.seal()
    self.unchanged(f)
 def test_every_original_fence_and_exact_member_inventory_remain_mandatory(self):
  for fault in (*range(5),'missing','extra','namespace'):
   with self.subTest(fault=fault):
    f=self.fixture();operation=Path(f.pins['operation'])
    if type(fault)is int:
     p=operation/('ci-runtime-fence-%02d.json'%fault);v=json.loads(p.read_bytes());v['stage']='R0';p.chmod(0o600);p.write_bytes(unstarted_fixture.prior.encoded(v));p.chmod(0o400);os.utime(p,(f.clock,f.clock));f.pins['members'][p.name]={**published.identity(p),'sha256':ci.sha(p.read_bytes())}
    elif fault=='missing':(operation/'ci-runtime-fence-04.json').unlink();f.pins['members'].pop('ci-runtime-fence-04.json')
    elif fault=='extra':(operation/'unreviewed.json').write_text('{}')
    else:(f.operation/'unstarted-recovery-unreviewed').mkdir()
    f.pins['operationIdentity']=published.identity(operation)
    with self.assertRaises(ValueError):f.seal()
    self.unchanged(f)
 def test_stopped_no_forced_kill_observation_and_seal_freshness_cannot_be_waived(self):
  for fault in ('stopped','disabled','forcedKill','accepted'):
   with self.subTest(fault=fault):
    f=self.fixture();p=Path(f.pins['operation'])/'activation-failure-observation.json';v=json.loads(p.read_bytes());v[fault]=not v[fault];p.chmod(0o600);p.write_bytes(unstarted_fixture.prior.encoded(v));p.chmod(0o400);os.utime(p,(f.clock,f.clock));f.pins['members'][p.name]={**published.identity(p),'sha256':ci.sha(p.read_bytes())};f.pins['operationIdentity']=published.identity(p.parent)
    with self.assertRaisesRegex(ValueError,'stopped rejected F5'):f.seal()
    self.unchanged(f)
  f=self.fixture();proof=f.seal();f.clock+=301
  with self.assertRaises(ValueError):f.invoke_published(published.LIVE_STAGE,f.live(proof))
  self.unchanged(f)


if __name__=='__main__':unittest.main()
