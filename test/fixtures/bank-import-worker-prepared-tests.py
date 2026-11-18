"""Hosted preparation/activation graph. Real files/locks/bytes; explicit systemd/proc/native-proof ports.
Optional --package uses the actual complete source-bound worker ZIP and a real >30s preparation.
"""
import contextlib,copy,hashlib,importlib.util,io,json,os,shutil,stat,sys,tempfile,time,unittest
from pathlib import Path
from types import ModuleType
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
REAL_SLEEP=time.sleep
if '--root-tree' in sys.argv:
    # Pure root file/manifest owner only. Never load the application/Node fixture as root.
    archive=Path(sys.argv[sys.argv.index('--package')+1]).resolve()
    def load(name,path):
        spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
    fmt=load('real_root_format',ROOT/'deploy/systemd/bank_import_worker_format.py');owner=load('real_root_prepared',ROOT/'deploy/systemd/bank_import_worker_prepared_v1.py')
    assert os.geteuid()==0
    import zipfile
    with zipfile.ZipFile(archive)as z:manifest=json.loads(z.read('worker-manifest.json'))
    with tempfile.TemporaryDirectory(prefix='aihr-prepared-root-',dir='/root')as tmp:
        root=Path(tmp)/'release';root.mkdir(mode=0o755);fmt.extract_archive(archive,root,manifest['source'],manifest['lockSha256'],manifest['packageSha256']);root.chmod(0o755)
        deadline=time.monotonic()+300;proof=owner.tree_identity(root,manifest,deadline=deadline,content=True);assert proof==owner.tree_identity(root,manifest,deadline=deadline)
        target=next(root/row['path']for row in manifest['entries']if row['type']=='file');original=target.read_bytes();target.write_bytes(original+b'!')
        try:owner.tree_identity(root,manifest,deadline=deadline,content=True)
        except ValueError:pass
        else:raise AssertionError('Real root content tamper was accepted')
        print(json.dumps({'kind':'ACTUAL_ROOT_FULL_PACKAGE_CONTENT_AND_METADATA','source':manifest['source'],'entries':proof['entries'],'bytes':proof['bytes'],'actualUid':os.geteuid(),'tamperRefused':True}))
    raise SystemExit(0)
core=ModuleType('conditional_fixture');core.__file__=str(ROOT/'test/fixtures/bank-import-worker-ci-runtime-tests.py')
exec(Path(core.__file__).read_text().rsplit('\nunittest.main()',1)[0],core.__dict__)
ci,guard,update=core.ci,core.guard,core.update
prepared=core.load_native('prepared_worker_owner','bank_import_worker_prepared_v1.py');prepared.configure(ci);ci.RECOVERY=prepared
actual_fmt=core.load_native('actual_prepared_format','bank_import_worker_format.py')
PACKAGE=None
if '--package'in sys.argv:
 i=sys.argv.index('--package');PACKAGE=Path(sys.argv[i+1]).resolve();del sys.argv[i:i+2]


def encoded(x):return json.dumps(x,sort_keys=True,separators=(',',':')).encode()+b'\n'

def replace(value,changes):
 if isinstance(value,str):return changes.get(value,value)
 if isinstance(value,list):return[replace(x,changes)for x in value]
 if isinstance(value,dict):return{k:replace(v,changes)for k,v in value.items()}
 return value


class Fixture(core.Fixture):
 def __init__(self,root,package=None):
  super().__init__(root);self.original_probe_modes=[];self.additional_root_private_files=set();self.whole_package=package is not None
  if package:
   import zipfile
   with zipfile.ZipFile(package)as z:manifest=json.loads(z.read('worker-manifest.json'))
   old=self.source;changes={old:manifest['source'],'a'*64:manifest['lockSha256'],'b'*64:manifest['packageSha256']}
   operation=self.operation;self.source=manifest['source'];operation.rename(self.operation)
   self.archive.write_bytes(package.read_bytes());(self.operation/'authenticated-worker.zip').write_bytes(package.read_bytes())
   self.fmt=actual_fmt;self.manifest=manifest
   for key in('grant','runtime','activated','verified','auth','first','current','prior'):setattr(self,key,replace(getattr(self,key),changes))
   m=json.loads(self.source_manifest_file.read_bytes());m['source']=self.source;self.source_manifest_file.write_bytes(encoded(m));self.auth['sourceManifestSha256']=ci.sha(self.source_manifest_file.read_bytes());self.first['sourceManifestSha256']=self.auth['sourceManifestSha256']
  else:
   raw=b'fictional package';self.manifest={'entries':[{'path':'package.json','type':'file','mode':0o644,'size':len(raw),'sha256':ci.sha(raw)}]}
  # Assemble the fictitious initial drain before exercising any reviewed operation.
  record=json.loads((self.operation/'drained.json').read_bytes());record['manifestSha256']=self.fmt.digest(self.fmt.canonical(self.manifest));record['identity']=copy.deepcopy(self.auth['identity']);record['identity']['archive_sha256']=ci.sha(self.archive.read_bytes())
  self.auth['identity']=record['identity'];self.auth['drainSha256']=ci.sha(self.fmt.canonical(record));(self.operation/'drained.json').chmod(0o600);(self.operation/'drained.json').write_bytes(self.fmt.canonical(record));(self.operation/'drained.json').chmod(0o400);os.utime(self.operation/'drained.json',(1794873602,1794873602))
  self.first['identity']=copy.deepcopy(record['identity']);self.first['gate']={k:self.grant[k]for k in('source','controller','runId','build','artifact','witnessFingerprint','policyVersion')}
  self.firstfile.write_bytes(encoded(self.first));self.auth['firstStageApprovalSha256']=ci.sha(self.firstfile.read_bytes())
  for name,value in [('authorization.json',self.grant),('runtime.json',self.runtime),('activated.json',self.activated),('verified.json',self.verified)]:self.private_record(name,value)
  self.auth.update(grantSha256=ci.sha(encoded(self.grant)),runtimeSha256=ci.sha(encoded(self.runtime)),activatedSha256=ci.sha(encoded(self.activated)))
  self.current['log']=str(root/'original-deploy.log');self.auth['launch']['current']['log']=self.current['log'];self.write_records();self.original_auth=copy.deepcopy(self.auth);self.events=[];self.saved_tree=None
 def native(self,argv,identity,environment,**options):
  if '-e'in argv and argv[argv.index('-e')+1]==prepared.FAILED_NATIVE_PROBE:
   self.original_probe_modes.append('original-failure-admission')
   return{'kind':'EXACT_FAILED_NATIVE_WORKER_CHECK_INSTALL','source':self.source,'installId':self.install_id,'active':copy.deepcopy(self.runtime)}
  if '-e'in argv and argv[argv.index('-e')+1]==ci.FAST_PROBE.replace('validateInstallGrant(grant);','validateInstallGrant(grant,{allowExpired:true});',1):
   self.original_probe_modes.append('read-only-expired-fast');argv=list(argv);argv[argv.index('-e')+1]=ci.FAST_PROBE
  if 'resume-status'in argv:
   self.original_probe_modes.append('resume-status');argv=list(argv);argv[argv.index('resume-status')]='status'
  return super().native(argv,identity,environment,**options)
 def iso(self,seconds=0):return ci.datetime.fromtimestamp(self.clock+seconds,ci.timezone.utc).isoformat()
 def approval(self,path,value):
  path.write_bytes(encoded(value));path.chmod(0o600);self.additional_root_private_files.add(path);return path
 def prepare_record(self,recovery=False):
  ident='a0000000-0000-4000-8000-000000000007';failure=None
  if recovery:
   old=self.approval(self.root/'retained-original-activation.json',self.original_auth)
   started=self.operation/'ci-runtime-started.json';self.approval(started,{'authorizationSha256':ci.sha(old.read_bytes()),'journeyVerified':False});os.utime(started,(1794873610,1794873610))
   directory=self.operation/'activation-release';directory.mkdir(mode=0o755);self.fmt.extract_archive(self.archive,directory,self.source,self.auth['identity']['lock_sha256'],self.auth['identity']['package_sha256']);directory.chmod(0o755)
   self.current.update(result='failed',exit_code='1',finished_at='1794874210');self.write_records();shutil.rmtree(self.proc/self.current['pid'])
   log=Path(self.current['log']);log.write_text('actual fixed-port final worker check failed after native activation\n')
   failure={'originalOperation':str(self.operation),'originalActivationApproval':str(old),'originalActivationApprovalSha256':ci.sha(old.read_bytes()),'originalStartedSha256':ci.sha(started.read_bytes()),'failureCurrentSha256':ci.sha((self.state/'current').read_bytes()),'failureLastOkSha256':ci.sha((self.state/'last-ok').read_bytes()),'failureLog':str(log),'failureLogSha256':ci.sha(log.read_bytes()),'failureFinishedAt':self.current['finished_at']}
   self.clock+=1900;self.held_phase='installing';s=directory.stat();d={'device':s.st_dev,'inode':s.st_ino,'uid':s.st_uid,'gid':s.st_gid,'mode':stat.S_IMODE(s.st_mode)}
  else:
   directory=self.operation/('prepared-'+ident);d=None;self.held_phase='claimed';self.web=self.previous_web
  output=self.operation/('prepared-worker-'+ident+'.json');self.additional_root_private_files.add(output)
  a={**copy.deepcopy(self.first),'kind':prepared.KINDS['prepare-ci-worker'],'issuedAt':self.iso(),'expiresAt':self.iso(300),'preparation':{'policy':prepared.POLICY,'mode':'failed-preunit'if recovery else'normal','id':ident,'firstStageApproval':str(self.firstfile),'firstStageApprovalSha256':ci.sha(self.firstfile.read_bytes()),'drainSha256':self.auth['drainSha256'],'directory':str(directory),'directoryIdentity':d,'proof':str(output),'failure':failure}}
  return a
 @contextlib.contextmanager
 def prepared_ports(self):
  real_tree=prepared.tree_identity
  with self.ports(),patch.object(prepared,'INSTALL_LOCK',self.root/'install.lock'),patch.object(prepared,'tree_identity',side_effect=lambda *args,**kw:real_tree(*args,**{**kw,'uid':os.getuid()})),patch.object(update,'unit_or_identity_processes',return_value=[]):yield
 def invoke_preparation(self,record,*,umask=None):
  path=self.approval(self.root/'finite-preparation.json',record);self.auth=record
  with self.prepared_ports(),contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
   old=os.umask(umask)if umask is not None else None
   try:guard.launch(['guarded-prepare-ci-worker','--approval',str(path),'--approval-sha256',ci.sha(path.read_bytes())],self.fmt,self.base,ci,update)
   finally:
    if old is not None:os.umask(old)
  proof=Path(record['preparation']['proof']);os.utime(proof,(self.clock,self.clock));return proof
 def live_record(self,preparation,proof):
  a=copy.deepcopy(self.original_auth);a.update(kind=prepared.KINDS['recover-ci-runtime'if preparation['preparation']['failure']else'activate-prepared-ci-runtime'],issuedAt=self.iso(),expiresAt=self.iso(900),preparedWorker={'path':str(proof),'sha256':ci.sha(proof.read_bytes())})
  if preparation['preparation']['failure']:a['recovery']=copy.deepcopy(preparation['preparation']['failure'])
  return a
 def invoke_live(self,a):
  path=self.approval(self.root/'live-prepared-activation.json',a);self.auth=a;self.web=self.source;self.held_phase='installing'
  mode='guarded-recover-ci-runtime'if'recovery'in a else'guarded-activate-prepared-ci-runtime'
  with self.prepared_ports(),contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):guard.launch([mode,'--approval',str(path),'--approval-sha256',ci.sha(path.read_bytes())],self.fmt,self.base,ci,update)
  operation=self.operation if'recovery'not in a else self.operation/('recovery-'+json.loads(Path(a['preparedWorker']['path']).read_bytes())['preparation']['id'])
  return json.loads((operation/'activated.json').read_bytes())


class PreparedFlowTests(unittest.TestCase):
 def fixture(self):
  t=tempfile.TemporaryDirectory();self.addCleanup(t.cleanup);return Fixture(Path(t.name))
 def assert_no_unit_mutation(self,f):
  self.assertFalse(any(isinstance(x,(list,tuple))and len(x)>1 and x[0]=='/usr/bin/systemctl'and x[1]in('start','daemon-reload','stop','disable','enable')for x in f.events));self.assertEqual(f.unit.read_text(),f.service_unit(f.previous_worker));self.assertFalse((f.app/'releases'/f.source).exists())
 def test_no_mutation_oracle_detects_actual_list_event(self):
  f=self.fixture();f.events.append(['/usr/bin/systemctl','start','aihr-bank-import.service']);self.assertRaises(AssertionError,self.assert_no_unit_mutation,f)
 def test_normal_prepared_wrapper_full_graph(self):
  f=self.fixture();a=f.prepare_record();proof=f.invoke_preparation(a);self.assert_no_unit_mutation(f);r=f.invoke_live(f.live_record(a,proof));self.assertTrue(r['serviceStable']);self.assertFalse(r['journeyVerified']);self.assertEqual(r['completeMetadataFences'],10);self.assertEqual(r['fullNativeAudits'],2)
 def test_normal_preparation_normalizes_restrictive_umask(self):
  f=self.fixture();a=f.prepare_record();proof=f.invoke_preparation(a,umask=0o077);self.assertEqual(stat.S_IMODE(Path(a['preparation']['directory']).stat().st_mode),0o755);self.assertTrue(f.invoke_live(f.live_record(a,proof))['serviceStable'])
 def test_exact_failed_preunit_expired_grant_full_graph_preserves_failure(self):
  f=self.fixture();a=f.prepare_record(True);old=(f.operation/'ci-runtime-started.json').read_bytes();current=(f.state/'current').read_bytes();proof=f.invoke_preparation(a);r=f.invoke_live(f.live_record(a,proof));self.assertEqual(r['mode'],'recover-ci-runtime');self.assertEqual(r['transitionStages'],['F']*10);self.assertEqual(f.original_probe_modes.count('resume-status'),2);self.assertEqual((f.operation/'ci-runtime-started.json').read_bytes(),old);self.assertEqual((f.state/'current').read_bytes(),current);self.assertFalse(r['journeyVerified'])
 def test_unknown_failed_nonzero_or_deactivating_prior_never_admits(self):
  for field,value in [('Result','exit-code'),('ExecMainStatus','7'),('SubState','stop'),('ActiveState','failed'),('UnitFileState','disabled')]:
   with self.subTest(field=field):
    f=self.fixture();a=f.prepare_record(True);proof=f.invoke_preparation(a);f.report[field]=value;self.assertRaisesRegex(ValueError,'clean drain|configuration',f.invoke_live,f.live_record(a,proof));self.assertFalse(any(x.name.startswith('recovery-')for x in f.operation.iterdir()));self.assert_no_unit_mutation(f)
 def test_slot_is_clipped_to_existing_global_deadline_and_child_cannot_rearm(self):
  from types import SimpleNamespace
  o=ci.RuntimeObservation.__new__(ci.RuntimeObservation);o.base=SimpleNamespace(check=core.check);o.auth={'expiresAt':'2026-11-17T00:15:00Z'};o.grant={'expiresAt':'2026-11-17T00:30:00Z'};o.recovery=None;o.overall_deadline=827;o.slot_name=None
  with patch.object(ci.time,'monotonic',return_value=700),patch.object(ci.time,'time',return_value=1794873600),patch.object(ci,'SLOT_DEADLINE',None):
   o.slot('A0',180);self.assertEqual(ci.SLOT_DEADLINE,827);self.assertEqual(o.base.VERIFIED_OPERATION_DEADLINE,827)
   with patch.object(ci.time,'monotonic',return_value=828),patch.object(ci,'bounded_process',side_effect=AssertionError('Expired global budget spawned child')):
    self.assertRaisesRegex(ValueError,'expired',ci.child,[sys.executable,'-c','print(1)'],SimpleNamespace(pw_uid=os.getuid(),pw_gid=os.getgid()),{},timeout=180)
 def test_prepared_file_bytes_must_authenticate_before_seal(self):
  f=self.fixture();a=f.prepare_record(True);Path(a['preparation']['directory'],'package.json').write_text('altered');self.assertRaisesRegex(ValueError,'content differs',f.invoke_preparation,a);self.assertFalse(Path(a['preparation']['proof']).exists());self.assert_no_unit_mutation(f)
 def test_live_file_drift_refuses_without_recovery_publication(self):
  f=self.fixture();a=f.prepare_record(True);proof=f.invoke_preparation(a);Path(a['preparation']['directory'],'package.json').write_text('altered');self.assertRaisesRegex(ValueError,'differs|changed',f.invoke_live,f.live_record(a,proof));self.assertFalse(any(x.name.startswith('recovery-')for x in f.operation.iterdir()));self.assert_no_unit_mutation(f)
 def test_changed_terminal_failure_refuses_without_attempt_directory(self):
  f=self.fixture();a=f.prepare_record(True);proof=f.invoke_preparation(a);f.current['exit_code']='2';f.write_records();self.assertRaisesRegex(ValueError,'failure|terminal|changed',f.invoke_live,f.live_record(a,proof));self.assertFalse(any(x.name.startswith('recovery-')for x in f.operation.iterdir()));self.assert_no_unit_mutation(f)
 def test_global_cap_expiry_does_not_rearm_per_child(self):
  f=self.fixture();a=f.prepare_record(True);proof=f.invoke_preparation(a);f.advance_at=2;f.advance_seconds=0
  original=f.boundary
  def expired(kind,count):
   original(kind,count)
   if kind=='fast'and count==2:f.monotonic_offset+=828
  f.boundary=expired;self.assertRaisesRegex(ValueError,'deadline|expired|opportunity',f.invoke_live,f.live_record(a,proof));self.assert_no_unit_mutation(f)
 def test_new_authority_expiry_is_fatal(self):
  f=self.fixture();a=f.prepare_record(True);proof=f.invoke_preparation(a);live=f.live_record(a,proof);live['expiresAt']=live['issuedAt'];self.assertRaisesRegex(ValueError,'expired|authority',f.invoke_live,live);self.assert_no_unit_mutation(f)
 def test_old_expiry_is_not_rewritten_or_extended(self):
  f=self.fixture();a=f.prepare_record(True);before=(f.directory/'authorization.json').read_bytes();proof=f.invoke_preparation(a);f.invoke_live(f.live_record(a,proof));self.assertEqual((f.directory/'authorization.json').read_bytes(),before)
 def test_source_environment_pid_and_restart_negative_controls(self):
  for fault in('environment-proof','pid','ledger','wrong-install'):
   with self.subTest(fault=fault):
    f=self.fixture();a=f.prepare_record(True);proof=f.invoke_preparation(a);f.native_fault=fault;self.assertRaisesRegex(ValueError,'environment proof|native CI runtime|full-ledger identity',f.invoke_live,f.live_record(a,proof));self.assertGreaterEqual(f.native_calls,1);self.assert_no_unit_mutation(f)
 def test_worker_restart_and_post_start_failure_refuse_success(self):
  for fault in('restart','start'):
   with self.subTest(fault=fault):
    f=self.fixture();a=f.prepare_record(True);proof=f.invoke_preparation(a);f.fault=fault;self.assertRaisesRegex(RuntimeError,'activation failed',f.invoke_live,f.live_record(a,proof));self.assertTrue(any(isinstance(x,(list,tuple))and x==['/usr/bin/systemctl','start','aihr-bank-import.service']for x in f.events));self.assertFalse((f.app/'releases'/f.source/'worker-install-v2.json').exists())
 def test_manual_pid_change_without_restart_counter_never_accepts_or_stops_foreign(self):
  f=self.fixture();a=f.prepare_record(True);proof=f.invoke_preparation(a);original=f.boundary
  def changed(kind,count):
   original(kind,count)
   if kind=='fast'and count==5:f.report['MainPID']='999'
  f.boundary=changed;self.assertRaisesRegex(RuntimeError,'activation failed',f.invoke_live,f.live_record(a,proof));self.assertGreaterEqual(f.fast_calls,5);self.assertTrue(any(isinstance(x,(list,tuple))and x==['/usr/bin/systemctl','start','aihr-bank-import.service']for x in f.events));self.assertFalse((f.app/'releases'/f.source/'worker-install-v2.json').exists());self.assertFalse(any(isinstance(x,(list,tuple))and len(x)>1 and x[1]=='stop'for x in f.events))
 def test_normal_prepared_also_has_fixed_global_cap(self):
  f=self.fixture();a=f.prepare_record();proof=f.invoke_preparation(a);original=f.boundary
  def expired(kind,count):
   original(kind,count)
   if kind=='fast'and count==2:f.monotonic_offset+=828
  f.boundary=expired;self.assertRaisesRegex(ValueError,'deadline|expired|opportunity',f.invoke_live,f.live_record(a,proof));self.assert_no_unit_mutation(f)
 def test_original_started_marker_drift_refuses_without_mutation(self):
  f=self.fixture();a=f.prepare_record(True);proof=f.invoke_preparation(a);(f.operation/'ci-runtime-started.json').write_text('{}');self.assertRaisesRegex(ValueError,'marker',f.invoke_live,f.live_record(a,proof));self.assert_no_unit_mutation(f)
 def test_preparation_seal_cannot_be_replaced(self):
  f=self.fixture();a=f.prepare_record(True);proof=f.invoke_preparation(a);live=f.live_record(a,proof);proof.chmod(0o600);proof.write_bytes(proof.read_bytes()+b' ');proof.chmod(0o400);self.assertRaisesRegex(ValueError,'seal|proof',f.invoke_live,live);self.assert_no_unit_mutation(f)
 def test_unexpected_member_mode_or_link_refuses_before_seal(self):
  for fault in('extra','mode','link'):
   with self.subTest(fault=fault):
    f=self.fixture();a=f.prepare_record(True);d=Path(a['preparation']['directory'])
    if fault=='extra':(d/'extra').write_text('x')
    elif fault=='mode':(d/'package.json').chmod(0o666)
    else:(d/'package.json').unlink();(d/'package.json').symlink_to(f.archive)
    self.assertRaises(ValueError,f.invoke_preparation,a);self.assert_no_unit_mutation(f)


class ActualArchiveCapacityTests(unittest.TestCase):
 def test_actual_full_archive_preparation_over30_then_normal_full_wrapper(self):
  with tempfile.TemporaryDirectory()as tmp:
   f=Fixture(Path(tmp),PACKAGE);self.assertGreater(len(f.manifest['entries']),60000)
   raw_extract=f.fmt.extract_archive
   def expensive(*args,**kw):
    result=raw_extract(*args,**kw);REAL_SLEEP(31);return result
   started=time.monotonic();a=f.prepare_record()
   with patch.object(f.fmt,'extract_archive',side_effect=expensive):proof=f.invoke_preparation(a,umask=0o077)
   elapsed=time.monotonic()-started;self.assertGreater(elapsed,30);r=f.invoke_live(f.live_record(a,proof));self.assertEqual(r['completeMetadataFences'],10);self.assertEqual(r['fullNativeAudits'],2)
   print(json.dumps({'kind':'ACTUAL_FULL_WORKER_PACKAGE_PREPARED_NORMAL_GRAPH','source':f.source,'archiveBytes':PACKAGE.stat().st_size,'entries':len(f.manifest['entries']),'preparationElapsedSeconds':elapsed,'fixedLiveCapSeconds':827,'originalLivePreparationSeconds':30,'nativeProofPorts':'deterministic; actual files/hash/locks/elapsed','unitMutationBeforePreparation':False}))
 def test_actual_full_archive_failed_preunit_wrapper_preserves_original_failure(self):
  with tempfile.TemporaryDirectory()as tmp:
   f=Fixture(Path(tmp),PACKAGE);started=time.monotonic();a=f.prepare_record(True);REAL_SLEEP(31);proof=f.invoke_preparation(a);before=(f.state/'current').read_bytes();marker=(f.operation/'ci-runtime-started.json').read_bytes();r=f.invoke_live(f.live_record(a,proof));self.assertEqual(r['transitionStages'],['F']*10);self.assertEqual(r['fullNativeAudits'],2);self.assertEqual((f.state/'current').read_bytes(),before);self.assertEqual((f.operation/'ci-runtime-started.json').read_bytes(),marker);self.assertEqual(f.original_probe_modes.count('resume-status'),2)
   print(json.dumps({'kind':'ACTUAL_FULL_WORKER_PACKAGE_EXACT_FAILED_PREUNIT_RECOVERY_GRAPH','source':f.source,'entries':len(f.manifest['entries']),'elapsedSeconds':time.monotonic()-started,'originalFailedInstallPreserved':True,'originalGrantUnchanged':True,'fixedLiveCapSeconds':827,'nativeProofPorts':'deterministic; actual files/hash/locks/elapsed'}))
 def test_actual_full_archive_legacy30_negative_control(self):
  with tempfile.TemporaryDirectory()as tmp:
   f=Fixture(Path(tmp),PACKAGE);raw_extract=f.fmt.extract_archive
   def expensive(*args,**kw):
    result=raw_extract(*args,**kw);REAL_SLEEP(31);return result
   f.auth=copy.deepcopy(f.original_auth);f.persist_authority()
   with patch.object(f.fmt,'extract_archive',side_effect=expensive):self.assertRaisesRegex(ValueError,'expired|deadline',f.conditional)
   self.assertFalse((f.app/'releases'/f.source/'worker-install-v2.json').exists())

if __name__=='__main__':unittest.main(defaultTest='ActualArchiveCapacityTests'if PACKAGE is not None else'PreparedFlowTests')
