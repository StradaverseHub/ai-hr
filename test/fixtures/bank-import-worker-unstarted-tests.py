"""Whole real-file/lock F graph for an actually prepared, never-activated worker; no app/host actions."""
import contextlib,copy,io,json,os,shutil,tempfile,unittest
from pathlib import Path
from types import ModuleType
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
prior=ModuleType('unstarted_prepared_fixture');prior.__file__=str(ROOT/'test/fixtures/bank-import-worker-prepared-tests.py')
exec(Path(prior.__file__).read_text(),prior.__dict__)
ci,guard,prepared,update=prior.ci,prior.guard,prior.prepared,prior.update
unstarted=prior.core.load_native('unstarted_worker_owner','bank_import_worker_unstarted_v1.py');ci.UNSTARTED=unstarted;unstarted.configure(ci,prepared)


class UnstartedTests(unittest.TestCase):
 def fixture(self,*,legacy=False,expired=False):
  tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup);f=prior.Fixture(Path(tmp.name))
  if legacy:prior.core.qualify_legacy_baseline_fixture(f,before_launch=True);f.original_auth=copy.deepcopy(f.auth)
  p=f.prepare_record(policy=prepared.NORMAL_V2_POLICY);proof=f.invoke_preparation(p)
  self.assertFalse((f.operation/'ci-runtime-started.json').exists())
  f.helper.write_text('a separately qualified unstarted recovery helper')
  if expired:f.clock=ci.epoch(f.grant['expiresAt'])+1
  f.current.update(result='failed',exit_code='1',finished_at=str(int(f.clock)))
  f.write_records();shutil.rmtree(f.proc/f.current['pid'])
  log=Path(f.current['log']);log.write_text('actual fixed-port final worker check failed after native build activation\n')
  a=f.live_record(p,proof);a['kind']=unstarted.KINDS[unstarted.LIVE_STAGE]
  a['recovery']={'policy':unstarted.POLICY,'id':'b0000000-0000-4000-8000-000000000009','originalOperation':str(f.operation),'failureCurrentSha256':ci.sha((f.state/'current').read_bytes()),'failureLastOkSha256':ci.sha((f.state/'last-ok').read_bytes()),'failureLog':str(log),'failureLogSha256':ci.sha(log.read_bytes()),'failureFinishedAt':f.current['finished_at']}
  return f,p,proof,a
 def invoke(self,f,a,*,root_owned_marker=True):
  path=f.approval(f.root/'live-unstarted.json',a);f.auth=a;f.web=f.source;f.held_phase='installing'
  # Emulate only the exact root-created credential, using the existing descriptor port.
  # Real files, modes, link counts and every other ownership check remain unchanged.
  if root_owned_marker and 'recovery'in a:f.additional_root_private_files.add(f.operation/('unstarted-recovery-'+a['recovery']['id'])/'ci-runtime-started.json')
  with f.prepared_ports(),contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
   guard.launch(['guarded-'+unstarted.LIVE_STAGE,'--approval',str(path),'--approval-sha256',ci.sha(path.read_bytes())],f.fmt,f.base,ci,update)
  return json.loads((f.operation/('unstarted-recovery-'+a['recovery']['id'])/'activated.json').read_bytes())
 def no_mutation(self,f):
  self.assertFalse(any(isinstance(x,(list,tuple))and len(x)>1 and x[0]=='/usr/bin/systemctl'and x[1]in('start','daemon-reload','stop','disable','enable')for x in f.events))
  self.assertFalse((f.app/'releases'/f.source).exists())
 def test_full_f_graph_uses_real_normal_preparation_without_inventing_historical_activation(self):
  f,p,proof,a=self.fixture(expired=True);oldproof=proof.read_bytes();grant=(f.directory/'authorization.json').read_bytes();failed=(f.state/'current').read_bytes();first=f.firstfile.read_bytes()
  r=self.invoke(f,a)
  self.assertTrue(r['serviceStable']);self.assertEqual((r['fullNativeAudits'],r['completeMetadataFences']),(2,10));self.assertEqual(r['mode'],unstarted.LIVE_STAGE);self.assertEqual(r['policy'],unstarted.POLICY)
  self.assertEqual(r['transitionStages'],['F']*10);self.assertEqual((f.state/'current').read_bytes(),failed);self.assertEqual(proof.read_bytes(),oldproof);self.assertEqual(f.firstfile.read_bytes(),first);self.assertEqual((f.directory/'authorization.json').read_bytes(),grant)
  self.assertFalse((f.operation/'ci-runtime-started.json').exists());self.assertFalse(Path(p['preparation']['directory']).exists());self.assertTrue((f.app/'releases'/f.source).is_dir());self.assertIn('read-only-expired-fast',f.original_probe_modes)
 def test_qualified_legacy_baseline_and_normal_preparation_lineage_survive_entire_graph(self):
  f,p,proof,a=self.fixture(legacy=True,expired=True);last=(f.state/'last-ok').read_bytes();receipt=(f.old_release/'worker-install-v2.json').read_bytes()
  self.assertTrue(self.invoke(f,a)['serviceStable']);self.assertEqual((f.state/'last-ok').read_bytes(),last);self.assertEqual((f.old_release/'worker-install-v2.json').read_bytes(),receipt)
 def test_runner_owned_marker_without_exact_root_port_remains_refused(self):
  f,p,proof,a=self.fixture()
  with self.assertRaisesRegex(ValueError,'root-private non-linked operation credential required'):self.invoke(f,a,root_owned_marker=False)
  self.no_mutation(f)
 def test_running_or_non_worker_failure_is_not_admitted(self):
  for fault in ('running','phase','exit','finish','live-pid','pending'):
   with self.subTest(fault=fault):
    f,p,proof,a=self.fixture()
    if fault=='running':f.current['result']=''
    elif fault=='phase':f.current['phase']='migrate'
    elif fault=='exit':f.current['exit_code']='2'
    elif fault=='finish':a['recovery']['failureFinishedAt']='1'
    elif fault=='live-pid':(f.proc/f.current['pid']).mkdir()
    else:(f.state/'pending').write_text('ref='+f.source+'\n')
    f.write_records();a['recovery']['failureCurrentSha256']=ci.sha((f.state/'current').read_bytes())
    with self.assertRaises(ValueError):self.invoke(f,a)
    self.no_mutation(f)
 def test_prior_activation_recovery_or_candidate_release_is_refused_before_attempt(self):
  for marker in ('ci-runtime-started.json','ci-worker-start-request.json','activation-failed.json','recovery-old','published-recovery-old','unstarted-recovery-old','release'):
   with self.subTest(marker=marker):
    f,p,proof,a=self.fixture()
    if marker=='release':(f.app/'releases'/f.source).mkdir()
    elif marker.endswith('.json'):(f.operation/marker).write_text('{}')
    else:(f.operation/marker).mkdir()
    with self.assertRaisesRegex(ValueError,'prior activation|prior recovery|release already'):self.invoke(f,a)
    self.assertFalse(any(x.name=='unstarted-recovery-'+a['recovery']['id']for x in f.operation.iterdir()))
 def test_prepared_first_drain_and_actual_terminal_pins_cannot_be_rebound(self):
  for fault in ('prepared-sha','first-sha','drain-sha','last-ok','log-sha','launch','unknown-recovery-key','normal-policy'):
   with self.subTest(fault=fault):
    f,p,proof,a=self.fixture()
    if fault=='prepared-sha':a['preparedWorker']['sha256']='0'*64
    elif fault=='first-sha':a['firstStageApprovalSha256']='0'*64
    elif fault=='drain-sha':a['drainSha256']='0'*64
    elif fault=='last-ok':a['recovery']['failureLastOkSha256']='0'*64
    elif fault=='log-sha':a['recovery']['failureLogSha256']='0'*64
    elif fault=='launch':a['launch']['current']['pid']='12345'
    elif fault=='unknown-recovery-key':a['recovery']['originalActivationApproval']='invented'
    else:a['recovery']['policy']=prepared.POLICY
    with self.assertRaises((ValueError,KeyError)):self.invoke(f,a)
    self.no_mutation(f)
 def test_real_prepared_content_drift_refuses_before_worker_mutation(self):
  f,p,proof,a=self.fixture();Path(p['preparation']['directory'],'package.json').write_text('tampered')
  with self.assertRaisesRegex(ValueError,'changed|differs'):self.invoke(f,a)
  self.no_mutation(f)
 def test_new_approval_expiry_and_global827_are_not_reset(self):
  f,p,proof,a=self.fixture();a['expiresAt']=f.iso(-1)
  with self.assertRaises(ValueError):self.invoke(f,a)
  self.no_mutation(f)
  f,p,proof,a=self.fixture()
  with patch.object(f.base,'RECOVERY_OVERALL_DEADLINE',prior.time.monotonic()-1,create=True):
   with self.assertRaises(ValueError):self.invoke(f,a)
  self.no_mutation(f)
 def test_fresh_authority_cannot_admit_normal_r0_or_change_normal830_owner(self):
  source=(ROOT/'deploy/systemd/bank_import_worker_ci_runtime_v1.py').read_text();self.assertIn('estimated_normal=830',source);self.assertIn("'insufficient estimated global fork reservation; no mutation'",source)
  f,p,proof,a=self.fixture();a.pop('recovery');a['kind']=prepared.KINDS['activate-prepared-ci-runtime']
  with self.assertRaises(ValueError):self.invoke(f,a)
  self.no_mutation(f)


if __name__=='__main__':unittest.main()
