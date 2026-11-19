"""Real published owner sequence with exact prestart lineage and one non-rearming overall clock."""
import copy,json,os,subprocess,sys,tempfile,time,unittest
from pathlib import Path
from types import ModuleType,SimpleNamespace
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
fixture=ModuleType('overall_profile_fixture');fixture.__file__=str(ROOT/'test/fixtures/bank-import-worker-seal-completion-tests.py')
exec(Path(fixture.__file__).read_text().rsplit("\nif __name__",1)[0],fixture.__dict__)
profile=fixture.profile;origin=profile.origin;ci,published,prepared=fixture.ci,fixture.published,fixture.prepared
guard,update=origin.guard,origin.update


class OverallRecoveryTests(unittest.TestCase):
 def fixture(self):
  f=profile.RecoveryProfileTests.fixture(self);proof=f.seal();old=f.live(proof);old[published.BUDGET_KEY]=published.BUDGET_PROFILE;old[published.SEAL_FRESHNESS_KEY]=published.SEAL_FRESHNESS_POLICY
  actual=ci.RuntimeObservation.complete_fence
  def partial(o,*args,**kwargs):
   if o.fence_count==2:raise ValueError('Worker installation refused: aggregate proof slot expired')
   return actual(o,*args,**kwargs)
  with patch.object(ci.RuntimeObservation,'complete_fence',partial):
   with self.assertRaisesRegex(ValueError,'proof slot expired'):f.invoke_published(published.LIVE_STAGE,old)
  operation=f.operation/('published-recovery-'+json.loads(proof.read_bytes())['sealId'])
  self.assertEqual(set(os.listdir(operation)),published.PRESTART_MEMBERS)
  for path in operation.iterdir():os.utime(path,(f.clock,f.clock));f.additional_root_private_files.add(path)
  selected={'approval':str(f.lastApproval),'approvalSha256':ci.sha(f.lastApproval.read_bytes()),'seal':str(proof),'sealSha256':ci.sha(proof.read_bytes()),'sealIdentity':published.identity(proof),'operationIdentity':published.identity(operation),'members':{p.name:{**published.identity(p),'sha256':ci.sha(p.read_bytes())}for p in operation.iterdir()},'unitSha256':ci.sha(f.unit.read_bytes()),'workerState':{'MainPID':'0','ActiveState':'inactive','SubState':'dead','UnitFileState':'disabled'}}
  f.pins['previousPrestart']={operation.name:selected};f.old=old;f.nextSealId='d0000000-0000-4000-8000-000000000010';f.clock+=1;f.events=[]
  f.helper.write_text('a separately qualified overall execution helper')
  return f,operation
 def live(self,f):
  proof=f.seal();a=f.live(proof);a[published.EXECUTION_KEY]=published.EXECUTION_POLICY;a['expiresAt']=f.iso(2100)
  return a
 def test_real_sequence_slow_guard_source_native_audits_and_stability_share_one1800_deadline(self):
  f,partial=self.fixture();originals={p.name:p.read_bytes()for p in partial.iterdir()};a=self.live(f);deadlines=[];delayed=set();real_slot=ci.RuntimeObservation.slot;native=f.native;hash_owner=ci.bounded_file_sha256;source_owner=ci.RuntimeObservation.source_proof
  before_owner=guard.GuardedInvocation.before_mutation;fresh_owner=ci.RuntimeObservation.fresh_native_identity;write_owner=f.base.write_new;inside_final=[];fresh_times=[];delayed_at=[];fence_writes=[]
  def advance(seconds):f.clock+=seconds;f.monotonic_offset+=seconds
  def slot(o,name,seconds):
   result=real_slot(o,name,seconds);deadlines.append((name,ci.SLOT_DEADLINE));return result
  def slow_hash(*args,**kwargs):
   if inside_final and 'F2-guard'not in delayed:delayed.add('F2-guard');advance(90);delayed_at.append(f.clock)
   return hash_owner(*args,**kwargs)
  def before(g):
   observer=g.observer;selected=observer is not None and observer.slot_name=='F2'and 'F2-guard'not in delayed
   if selected:self.assertTrue(fresh_times,'F2 initial canonical fresh probe must precede final guard');inside_final.append(True)
   try:return before_owner(g)
   finally:
    if selected:inside_final.pop()
  def fresh(o):
   value=fresh_owner(o);fresh_times.append(f.clock);return value
  def write(path,*args,**kwargs):
   if Path(path).name=='ci-runtime-fence-02.json':
    self.assertTrue(delayed_at);self.assertGreaterEqual(fresh_times[-1],delayed_at[0],'A NEW canonical fresh observation must follow the slow final guard before publication');fence_writes.append(True)
   return write_owner(path,*args,**kwargs)
  def source(o):
   if o.slot_name not in delayed:delayed.add(o.slot_name);advance(90)
   return source_owner(o)
  def slow_native(argv,*args,**kwargs):
   if 'resume-status'in argv:
    observer=ci.ACTIVE_OPERATION_GUARD.observer
    if observer.slot_name not in delayed:delayed.add(observer.slot_name);advance(220)
   return native(argv,*args,**kwargs)
  f.native=slow_native
  with patch.object(ci.RuntimeObservation,'slot',slot),patch.object(ci.RuntimeObservation,'source_proof',source),patch.object(ci,'bounded_file_sha256',slow_hash),patch.object(guard.GuardedInvocation,'before_mutation',before),patch.object(ci.RuntimeObservation,'fresh_native_identity',fresh),patch.object(f.base,'write_new',side_effect=write):f.invoke_published(published.LIVE_STAGE,a)
  result=json.loads((f.app/'releases'/f.source/'worker-install-v2.json').read_bytes())
  self.assertEqual(result[published.EXECUTION_KEY],published.EXECUTION_POLICY);self.assertEqual((result['fullNativeAudits'],result['completeMetadataFences']),(2,10));self.assertEqual(result['transitionStages'],['F']*10);self.assertEqual(f.actual_stability_sleeps,[4,4,4]);self.assertTrue(result['serviceStable']);self.assertEqual(len({deadline for _,deadline in deadlines}),1)
  self.assertTrue({'F2-guard','S0','S1','A0','A1'}<=delayed);self.assertTrue(any(name=='receipt'for name,_ in deadlines));self.assertEqual({p.name:p.read_bytes()for p in partial.iterdir()},originals)
  self.assertEqual(fence_writes,[True])
 def test_exact_four_record_history_rejects_missing_extra_mutated_authority_and_foreign_unit(self):
  for fault in ('missing','extra','F0','A0','approval','unit','state','unknown-attempt'):
   with self.subTest(fault=fault):
    f,operation=self.fixture();selected=f.pins['previousPrestart'][operation.name]
    if fault=='missing':(operation/'ci-runtime-fence-01.json').unlink()
    elif fault=='extra':(operation/'activation-failed.json').write_text('{}')
    elif fault in ('F0','A0'):
     p=operation/('ci-runtime-fence-00.json'if fault=='F0'else'ci-runtime-full-audit-0.json');p.chmod(0o600);p.write_text('{}');p.chmod(0o400)
    elif fault=='approval':selected['approvalSha256']='0'*64
    elif fault=='unit':selected['unitSha256']='0'*64
    elif fault=='state':selected['workerState']['MainPID']='999'
    else:(f.operation/'published-recovery-unreviewed').mkdir()
    with self.assertRaises((ValueError,KeyError)):f.seal()
    self.assertFalse((f.app/'releases'/f.source/'worker-install-v2.json').exists())
 def test_policy_selection_is_closed_and_old_root900_and_slot_limits_remain(self):
  f,operation=self.fixture();a=self.live(f);b=SimpleNamespace(check=origin.unstarted_fixture.prior.core.check)
  for changes in ({published.EXECUTION_KEY:'unknown'},{'kind':'ADMIN_AUTHORIZED_SINGLE_CI_WORKER_CUTOVER'},{published.BUDGET_KEY:'unknown'},{published.SEAL_FRESHNESS_KEY:'unknown'}):
   with self.assertRaises(ValueError):published.budget_fields(b,ci,set(),{**a,**changes},published.LIVE_STAGE)
  with self.assertRaises(ValueError):published.budget_fields(b,ci,set(),a,published.SEAL_STAGE)
  a.pop(published.EXECUTION_KEY)
  with self.assertRaisesRegex(ValueError,'finite administrator'):f.invoke_published(published.LIVE_STAGE,a)
  self.assertEqual(ci.OVERALL_EXECUTION_DEADLINE,None)
 def test_native_process_and_base_command_use_same_overall_remaining_above600_without_legacy_caps(self):
  # Real streaming subprocess owner with a harmless child; clock supplies a long remaining budget, no long wait.
  with patch.object(ci,'OVERALL_EXECUTION_DEADLINE',time.monotonic()+1700),patch.object(ci,'FAILURE_CLEANUP_ONLY',False):
   self.assertGreater(ci.execution_timeout(20),1600)
   result=ci.bounded_process([sys.executable,'-c','print("actual child")'],timeout=20);self.assertEqual(result.strip(),'actual child')
  base=origin.unstarted_fixture.prior.core.load_native('overall_actual_base','bank_import_worker_installer_v2.py');observed=[]
  with patch.object(base,'OVERALL_EXECUTION_DEADLINE',time.monotonic()+1700,create=True),patch.object(base.subprocess,'run',side_effect=lambda *args,**kw:(observed.append(kw['timeout'])or SimpleNamespace(returncode=0,stdout=''))):base.command(['/usr/bin/true'])
  self.assertGreater(observed[0],1600)
 def test_overall_exhaustion_before_start_never_mutates_and_after_owned_start_only_quarantines(self):
  for phase in ('F2','F5'):
   with self.subTest(phase=phase):
    f,operation=self.fixture();a=self.live(f);actual=ci.RuntimeObservation.complete_fence;done=[]
    def exhaust(o,*args,**kwargs):
     if o.fence_count==int(phase[1:])and not done:done.append(True);f.clock+=1801;f.monotonic_offset+=1801
     return actual(o,*args,**kwargs)
    with patch.object(ci.RuntimeObservation,'complete_fence',exhaust):
     with self.assertRaises((ValueError,RuntimeError)):f.invoke_published(published.LIVE_STAGE,a)
    self.assertFalse((f.app/'releases'/f.source/'worker-install-v2.json').exists());self.assertEqual(f.report['MainPID'],'0')
    if phase=='F2':self.assertFalse(any(x==['/usr/bin/systemctl','start','aihr-bank-import.service']for x in f.events))
    else:self.assertEqual(f.report['UnitFileState'],'disabled');self.assertTrue(any(x==['/usr/bin/systemctl','start','aihr-bank-import.service']for x in f.events))
  self.assertIsNone(ci.OVERALL_EXECUTION_DEADLINE);self.assertFalse(ci.FAILURE_CLEANUP_ONLY)
 def test_root2100_ledgerfresh60_and_nonrenewing_global_deadline_are_enforced(self):
  f,operation=self.fixture();a=self.live(f);a['expiresAt']=f.iso(2101)
  with self.assertRaisesRegex(ValueError,'finite administrator'):f.invoke_published(published.LIVE_STAGE,a)
  now=1794874000;b=SimpleNamespace(check=origin.unstarted_fixture.prior.core.check);stamp=ci.datetime.fromtimestamp(now-61,ci.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
  with self.assertRaisesRegex(ValueError,'stale'):ci.native_timestamp(b,stamp,now-3600,now,fresh=True)
  with patch.object(ci,'OVERALL_EXECUTION_DEADLINE',time.monotonic()-1),patch.object(ci,'FAILURE_CLEANUP_ONLY',False):
   with self.assertRaisesRegex(ValueError,'overall execution deadline'):ci.execution_timeout(600)


if __name__=='__main__':unittest.main()
