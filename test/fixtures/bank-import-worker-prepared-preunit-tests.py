"""Hosted-only prepared preunit recovery: real file/lock/graph ports; synthetic identities only."""
import contextlib,copy,io,json,os,shutil,tempfile,unittest
from pathlib import Path
from types import ModuleType
ROOT=Path(__file__).resolve().parents[2]
owner=ModuleType('prepared_preunit_fixture');owner.__file__=str(ROOT/'test/fixtures/bank-import-worker-prepared-tests.py')
exec(Path(owner.__file__).read_text().rsplit('\nunittest.main()',1)[0],owner.__dict__)
prepared,ci,guard,update=owner.prepared,owner.ci,owner.guard,owner.update
encoded=owner.encoded

class Fixture(owner.Fixture):
 def failed_prepared(self):
  preparation=self.prepare_record(policy=prepared.NORMAL_V2_POLICY);proof=self.invoke_preparation(preparation)
  self.prior.update(result='failed',exit_code='0',finished_at='1794873590');self.write_records()
  self.original_auth['priorLastOkSha256']=ci.sha((self.state/'last-ok').read_bytes())
  normal=self.live_record(preparation,proof)
  try:self.invoke_live(normal)
  except ValueError as error:
   if 'prior last-ok is invalid'not in str(error):raise
  else:raise AssertionError('Original normal prepared activation accepted a failed-result baseline')
  historical=self.root/'live-prepared-activation.json';started=self.operation/'ci-runtime-started.json'
  os.utime(started,(self.clock+1,self.clock+1))
  self.current.update(result='failed',exit_code='1',finished_at='1794874210');self.write_records();shutil.rmtree(self.proc/self.current['pid'])
  log=Path(self.current['log']);log.write_text('actual final worker readiness check failed after the compiled runtime was verified\n')
  failure={'originalOperation':str(self.operation),'originalActivationApproval':str(historical),'originalActivationApprovalSha256':ci.sha(historical.read_bytes()),'originalStartedSha256':ci.sha(started.read_bytes()),'failureCurrentSha256':ci.sha((self.state/'current').read_bytes()),'failureLastOkSha256':ci.sha((self.state/'last-ok').read_bytes()),'failureLog':str(log),'failureLogSha256':ci.sha(log.read_bytes()),'failureFinishedAt':self.current['finished_at']}
  self.clock+=1900
  self.helper.write_text('a distinct hosted-qualified prepared-preunit administrator bundle')
  recovery=copy.deepcopy(normal);recovery.update(kind=prepared.KINDS[prepared.PREUNIT_STAGE],helperSha256=ci.sha(self.helper.read_bytes()),issuedAt=self.iso(),expiresAt=self.iso(900),recovery=failure,preparedPreunit={'policy':prepared.PREUNIT_POLICY,'id':'b0000000-0000-4000-8000-000000000008'})
  self.events=[]
  return recovery,proof
 def invoke_preunit(self,a):
  path=self.approval(self.root/'fresh-prepared-preunit-recovery.json',a);self.auth=a;self.web=self.source;self.held_phase='installing'
  with self.prepared_ports(),contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
   guard.launch(['guarded-'+prepared.PREUNIT_STAGE,'--approval',str(path),'--approval-sha256',ci.sha(path.read_bytes())],self.fmt,self.base,ci,update)
  operation=self.operation/('prepared-preunit-recovery-'+a['preparedPreunit']['id'])
  return json.loads((operation/'activated.json').read_bytes())

class PreparedPreunitTests(unittest.TestCase):
 def fixture(self):
  t=tempfile.TemporaryDirectory();self.addCleanup(t.cleanup);return Fixture(Path(t.name))
 def no_mutation(self,f,expected_unit=None):
  self.assertFalse(any(isinstance(x,(list,tuple))and len(x)>1 and x[0]=='/usr/bin/systemctl'and x[1]in('start','daemon-reload','stop','disable','enable')for x in f.events))
  self.assertEqual(f.unit.read_text(),f.service_unit(f.previous_worker) if expected_unit is None else expected_unit);self.assertFalse((f.app/'releases'/f.source).exists())
 def test_expired_original_prepared_authority_reuses_seal_full_graph_and_retains_all_failures(self):
  f=self.fixture();a,proof=f.failed_prepared();paths=[f.operation/'ci-runtime-started.json',Path(a['recovery']['originalActivationApproval']),f.state/'current',f.state/'last-ok',proof,f.firstfile,f.directory/'authorization.json',f.directory/'runtime.json']
  before={p:p.read_bytes()for p in paths};root_identity=proof.stat().st_ino
  result=f.invoke_preunit(a)
  self.assertEqual(result['mode'],prepared.PREUNIT_STAGE);self.assertEqual(result['policy'],prepared.PREUNIT_POLICY)
  self.assertEqual(result['transitionStages'],['F']*10);self.assertEqual(result['completeMetadataFences'],10);self.assertEqual(result['fullNativeAudits'],2)
  self.assertTrue(result['fullSourceContentInventoryVerified']);self.assertTrue(result['serviceStable']);self.assertFalse(result['journeyVerified'])
  self.assertEqual(f.original_probe_modes.count('resume-status'),2)
  for p,raw in before.items():self.assertEqual(p.read_bytes(),raw)
  self.assertEqual(proof.stat().st_ino,root_identity)
 def test_original_installer_must_be_terminal_and_dead(self):
  for fault in('live','not-failed','other-exit','different-log','last-ok'):
   with self.subTest(fault=fault):
    f=self.fixture();a,_=f.failed_prepared()
    if fault=='live':(f.proc/f.current['pid']).mkdir()
    elif fault=='not-failed':f.current['result']='';f.write_records()
    elif fault=='other-exit':f.current['exit_code']='2';f.write_records()
    elif fault=='different-log':Path(f.current['log']).write_text('changed')
    else:f.prior['result']='';f.write_records()
    self.assertRaises((ValueError,FileNotFoundError),f.invoke_preunit,a);self.no_mutation(f)
 def test_unknown_policy_duplicate_attempt_or_relabelled_preparation_refuses(self):
  for fault in('policy','unknown-field','attempt','proof-selection','old-mode','old-kind'):
   with self.subTest(fault=fault):
    f=self.fixture();a,proof=f.failed_prepared()
    if fault=='policy':a['preparedPreunit']['policy']='unreviewed'
    elif fault=='unknown-field':a['preparedPreunit']['extra']=True
    elif fault=='attempt':(f.operation/'prepared-preunit-recovery-previous').mkdir()
    elif fault=='proof-selection':a['preparedWorker']['sha256']='0'*64
    elif fault=='old-mode':a['kind']=prepared.KINDS['recover-ci-runtime']
    else:
     p=Path(a['recovery']['originalActivationApproval']);old=json.loads(p.read_bytes());old['kind']='ADMIN_AUTHORIZED_SINGLE_CI_WORKER_CUTOVER';p.write_bytes(encoded(old));a['recovery']['originalActivationApprovalSha256']=ci.sha(p.read_bytes());(f.operation/'ci-runtime-started.json').write_bytes(encoded({'authorizationSha256':ci.sha(p.read_bytes()),'journeyVerified':False}));a['recovery']['originalStartedSha256']=ci.sha((f.operation/'ci-runtime-started.json').read_bytes())
    self.assertRaises((ValueError,FileNotFoundError),f.invoke_preunit,a);self.no_mutation(f)
 def test_published_release_prior_native_audit_or_prepared_tree_drift_refuses(self):
  for fault in('release','release-link','activated','start-request','audit','fence','content','inode','unit','worker'):
   with self.subTest(fault=fault):
    f=self.fixture();a,proof=f.failed_prepared()
    if fault=='release':(f.app/'releases'/f.source).mkdir()
    elif fault=='release-link':(f.app/'releases'/f.source).symlink_to(f.root/'absent-release')
    elif fault=='start-request':(f.operation/'ci-worker-start-request.json').symlink_to(f.root/'absent-start')
    elif fault=='fence':(f.operation/'ci-runtime-fence-01.json').write_bytes(b'{}')
    elif fault=='activated':(f.operation/'activated.json').write_bytes(b'{}')
    elif fault=='audit':(f.operation/'ci-runtime-full-audit-1.json').write_bytes(b'{}')
    elif fault=='content':Path(json.loads(proof.read_bytes())['directory'],'package.json').write_text('tampered')
    elif fault=='inode':
     p=Path(json.loads(proof.read_bytes())['directory'],'package.json');raw=p.read_bytes();p.rename(p.with_suffix('.retained'));p.write_bytes(raw)
    elif fault=='unit':f.unit.write_text('tampered')
    else:f.report.update(MainPID='99',ActiveState='active',SubState='running')
    self.assertRaises((ValueError,FileNotFoundError),f.invoke_preunit,a)
    if fault not in('release','release-link'):self.no_mutation(f,'tampered' if fault=='unit' else None)
    else:self.assertFalse(any(isinstance(x,(list,tuple))and len(x)>1 and x[0]=='/usr/bin/systemctl'and x[1]in('start','daemon-reload','stop','disable','enable')for x in f.events))
 def test_insufficient_new_authority_never_rearms_original_clocks(self):
  f=self.fixture();a,_=f.failed_prepared();a['expiresAt']=f.iso(550)
  self.assertRaisesRegex(ValueError,'opportunity|expired|deadline',f.invoke_preunit,a);self.no_mutation(f)

if __name__=='__main__':unittest.main()
