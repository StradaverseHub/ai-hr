"""Hosted explicit published recovery graph; real bytes/locks, deterministic native service ports."""
import contextlib,copy,io,json,os,tempfile,unittest
from pathlib import Path
from types import ModuleType
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
core=ModuleType('published_fixture');core.__file__=str(ROOT/'test/fixtures/bank-import-worker-prepared-tests.py')
exec(Path(core.__file__).read_text().rsplit('\nunittest.main()',1)[0],core.__dict__)
ci,prepared,guard,update=core.ci,core.prepared,core.guard,core.update
published=core.core.load_native('published_owner','bank_import_worker_published_v1.py')
published.configure(ci,prepared);ci.PUBLISHED=published

class Fixture(core.Fixture):
 def __init__(self,root):
  super().__init__(root);a=self.prepare_record(True);proof=self.invoke_preparation(a);old=self.live_record(a,proof)
  original=ci.RuntimeObservation.complete_fence
  def fail(o,*args,**kw):
   if o.started_sha is not None:raise ValueError('retained F4 fixture failure')
   return original(o,*args,**kw)
  with patch.object(ci.RuntimeObservation,'complete_fence',fail),patch.object(ci.RuntimeObservation,'publish_stopped_failure_observation',side_effect=ValueError('original observation unavailable')):
   try:self.invoke_live(old)
   except RuntimeError:pass
   else:raise AssertionError('Expected original failed cutover')
  self.old=old;self.oldpath=self.root/'live-prepared-activation.json'
  operation=self.operation/('recovery-'+a['preparation']['id'])
  for p in operation.iterdir():os.utime(p,(self.clock,self.clock));self.additional_root_private_files.add(p)
  release=self.app/'releases'/self.source
  self.pins={'approval':str(self.oldpath),'approvalSha256':ci.sha(self.oldpath.read_bytes()),'operation':str(operation),
             'operationIdentity':published.identity(operation),'members':{p.name:{**published.identity(p),'sha256':ci.sha(p.read_bytes())}for p in operation.iterdir()},
             'releaseIdentity':published.identity(release),'unitSha256':ci.sha(self.unit.read_bytes())}
  self.clock+=1;self.events=[]
 def seal_record(self):
  a=copy.deepcopy(self.first);a.update(kind=published.KINDS[published.SEAL_STAGE],helperSha256=ci.sha(self.helper.read_bytes()),
    issuedAt=self.iso(),expiresAt=self.iso(300),publishedFailure=self.pins,sealId='b0000000-0000-4000-8000-000000000008')
  return a
 def invoke_published(self,stage,a):
  path=self.approval(self.root/(stage+'.json'),a);self.auth=a
  with self.prepared_ports(),contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
   guard.launch(['guarded-'+stage,'--approval',str(path),'--approval-sha256',ci.sha(path.read_bytes())],self.fmt,self.base,ci,update)
 def seal(self):
  a=self.seal_record();proof=self.operation/('published-worker-'+a['sealId']+'.json');self.additional_root_private_files.add(proof)
  self.invoke_published(published.SEAL_STAGE,a);os.utime(proof,(self.clock,self.clock));return proof
 def live(self,proof):
  a=copy.deepcopy(self.old);a.update(kind=published.KINDS[published.LIVE_STAGE],helperSha256=ci.sha(self.helper.read_bytes()),
    issuedAt=self.iso(),expiresAt=self.iso(900),publishedSeal={'path':str(proof),'sha256':ci.sha(proof.read_bytes()),'identity':published.identity(proof)})
  return a

class PublishedTests(unittest.TestCase):
 def fixture(self):
  t=tempfile.TemporaryDirectory();self.addCleanup(t.cleanup);return Fixture(Path(t.name))
 def unchanged(self,f):
  self.assertFalse(any(type(x)is list and len(x)>1 and x[0]=='/usr/bin/systemctl'and x[1]in('start','stop','daemon-reload','disable','enable')for x in f.events))
  self.assertEqual(ci.sha(f.unit.read_bytes()),f.pins['unitSha256']);self.assertFalse((f.app/'releases'/f.source/'worker-install-v2.json').exists())
 def test_full_graph_recovers_published_bytes_without_extract_rename_or_history_changes(self):
  f=self.fixture();proof=f.seal();self.unchanged(f);before=copy.deepcopy(f.pins)
  with patch.object(prepared.os,'rename',side_effect=AssertionError('Published release must not be renamed')):
   f.invoke_published(published.LIVE_STAGE,f.live(proof))
  receipt=json.loads((f.app/'releases'/f.source/'worker-install-v2.json').read_bytes())
  self.assertTrue(receipt['publishedRecoveryOnly']);self.assertTrue(receipt['serviceStable']);self.assertFalse(receipt['journeyVerified'])
  self.assertEqual(receipt['publishedSealSha256'],ci.sha(proof.read_bytes()))
  for name,pins in before['members'].items():
   p=Path(before['operation'])/name;self.assertEqual({**published.identity(p),'sha256':ci.sha(p.read_bytes())},pins)
 def test_seal_refuses_wrong_bytes_foreign_unit_or_nonterminal_process(self):
  cases={'bytes':lambda f:(f.app/'releases'/f.source/'package.json').write_bytes(b'changed package!!'),
   'unit':lambda f:f.unit.write_text('foreign unit'), 'running':lambda f:f.report.update(MainPID='987',ActiveState='active'),
   'enabled':lambda f:f.report.update(UnitFileState='enabled'), 'pid-reuse':lambda f:(f.proc/'456').mkdir(),
   'receipt':lambda f:(f.app/'releases'/f.source/'worker-install-v2.json').write_text('{}'),
   'member':lambda f:(Path(f.pins['operation'])/'unknown.json').write_text('{}'),
   'boot':lambda f:f.boot.write_text('new boot')}
  for name,mutate in cases.items():
   with self.subTest(name=name):
    f=self.fixture();mutate(f)
    with self.assertRaises(ValueError):f.seal()
    self.assertFalse(any(type(x)is list and len(x)>1 and x[1]=='start'for x in f.events))
 def test_live_refuses_stale_seal_reused_attempt_and_changed_installed_metadata(self):
  for defect in('stale','attempt','tree','approval','history'):
   with self.subTest(defect=defect):
    f=self.fixture();proof=f.seal()
    if defect=='stale':f.clock+=301
    if defect=='attempt':(f.operation/'published-recovery-existing').mkdir()
    if defect=='tree':os.chmod(f.app/'releases'/f.source/'package.json',0o600)
    if defect=='approval':f.oldpath.write_text('{}')
    if defect=='history':(Path(f.pins['operation'])/'ci-worker-started.json').write_text('{}')
    with self.assertRaises(ValueError):f.invoke_published(published.LIVE_STAGE,f.live(proof))
    self.unchanged(f)
 def test_live_authority_expiry_and_global_clock_are_not_renewed(self):
  f=self.fixture();proof=f.seal();a=f.live(proof);a['expiresAt']=f.iso(-1)
  with self.assertRaises(ValueError):f.invoke_published(published.LIVE_STAGE,a)
  self.unchanged(f)

unittest.main()
