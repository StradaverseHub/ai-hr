"""Filesystem/refusal fixtures for the exact production transaction; no privileged paths or services."""
import base64, importlib.util, json, os, sqlite3, fcntl
from pathlib import Path
import subprocess, sys, tempfile, unittest
spec=importlib.util.spec_from_file_location('maintenance',Path(__file__).parents[1]/'deploy/security/maintenance.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='aihr-maintenance-fixture-');self.root=Path(self.temp.name);self.a=self.root/'existing';self.b=self.root/'new';self.a.write_bytes(b'original');self.a.chmod(0o600);self.events=[]
        def read(p):
            if not p.exists(): return None
            return m.regular(p,owner=os.getuid()),p.stat().st_mode&0o777
        def write(p,b,mode):
            temporary=p.with_name(p.name+'.temporary');temporary.write_bytes(b);temporary.chmod(mode);os.replace(temporary,p)
        self.ports={'read':read,'write':write,'remove':lambda p:p.unlink(),'fence':lambda:self.events.append('fence'),'prepare':lambda:self.events.append('prepare'),'activate':lambda:self.events.append('activate'),'verify':lambda:self.events.append('verify'),'quiesce':lambda:self.events.append('quiesce'),'restore_services':lambda:self.events.append('restore'),'record':lambda phase,p:self.events.append(phase)}
        self.changes=[(self.a,b'replacement',0o600,m.digest(b'original')),(self.b,b'new',0o600,None)]
    def tearDown(self): self.temp.cleanup()
    def controlled_failure(self): raise ValueError('Controlled fixture refusal')
    def test_success_fences_before_quiescence_and_each_write(self):
        m.apply_changes(self.changes,self.ports);self.assertEqual(self.a.read_bytes(),b'replacement');self.assertEqual(self.b.read_bytes(),b'new');self.assertEqual(self.events[:3],['fence','preparing','prepare']);self.assertEqual(self.events.count('fence'),3);self.assertEqual(self.events[-2:],['activate','verify'])
    def test_baseline_drift_refuses_before_service_stop(self):
        self.a.write_bytes(b'foreign');self.assertRaisesRegex(ValueError,'baseline drift',m.apply_changes,self.changes,self.ports);self.assertEqual(self.events,[]);self.assertEqual(self.a.read_bytes(),b'foreign');self.assertFalse(self.b.exists())
    def test_activation_failure_restores_original_bytes_and_removes_only_created_files(self):
        self.ports['activate']=self.controlled_failure;self.assertRaises(ValueError,m.apply_changes,self.changes,self.ports);self.assertEqual(self.a.read_bytes(),b'original');self.assertFalse(self.b.exists());self.assertIn('restore',self.events);self.assertEqual(self.events[-1],'rolled-back')
    def test_verification_failure_also_restores(self):
        self.ports['verify']=self.controlled_failure;self.assertRaises(ValueError,m.apply_changes,self.changes,self.ports);self.assertEqual(self.a.read_bytes(),b'original');self.assertFalse(self.b.exists());self.assertIn('restore',self.events)
    def test_foreign_change_is_never_overwritten_by_rollback(self):
        def fail_foreign(): self.a.write_bytes(b'foreign-after-install');raise ValueError('Controlled activation failure')
        self.ports['activate']=fail_foreign;self.assertRaisesRegex(ValueError,'foreign file changes',m.apply_changes,self.changes,self.ports);self.assertEqual(self.a.read_bytes(),b'foreign-after-install');self.assertFalse(self.b.exists());self.assertNotIn('rolled-back',self.events)
    def test_failed_lease_refuses_before_service_stop_or_file_change(self):
        self.ports['fence']=self.controlled_failure;self.assertRaises(ValueError,m.apply_changes,self.changes,self.ports);self.assertNotIn('prepare',self.events);self.assertEqual(self.a.read_bytes(),b'original');self.assertFalse(self.b.exists())
    def test_symlink_hardlink_and_group_write_are_refused(self):
        link=self.root/'link';link.symlink_to(self.a);self.assertRaises(ValueError,m.regular,link,owner=os.getuid());link.unlink();os.link(self.a,link);self.assertRaises(ValueError,m.regular,self.a,owner=os.getuid());link.unlink();self.a.chmod(0o660);self.assertRaises(ValueError,m.regular,self.a,owner=os.getuid())
    def test_exact_plan_refuses_foreign_targets_sources_and_embedded_hashes(self):
        value=b'server_name staging.example.invalid;\n';source='a'*40;agent='b'*64;node='c'*64
        plan={'kind':'STAGING_INGRESS_EMAIL_SECURITY','format':1,'source':source,'buildId':'fixture-build','workerBefore':'d'*64,'agentSha256':agent,'nodeSha256':node,'publicOrigin':'https://staging.example.invalid','files':[{'path':p,'before':None if p.endswith('00-aihr-request-protection.conf') else 'e'*64,'after':m.digest(value),'base64':base64.b64encode(value).decode()} for p in sorted(m.ALLOWED_NGINX)]}
        self.assertEqual(m.validate_plan(plan,source,agent,node),plan)
        for mutate in [lambda p:p.update(source='f'*40),lambda p:p.update(agentSha256='f'*64),lambda p:p['files'][0].update(path='/etc/sudoers'),lambda p:p['files'][0].update(after='f'*64),lambda p:p.update(extra=True)]:
            bad=json.loads(json.dumps(plan));mutate(bad);self.assertRaises(ValueError,m.validate_plan,bad,source,agent,node)
    def test_capabilities_cannot_be_activated_or_readiness_changed(self):
        before={'version':1,'ready':False,'attendanceCc':True};m.capabilities_preserved(before,{**before,'letters':False})
        for after in [{**before,'letters':True},{**before,'ready':True},{**before,'attendanceCc':False},{'version':1,'ready':False}]:self.assertRaises(ValueError,m.capabilities_preserved,before,after)
    def queue_fixture(self):
        queue=self.root/'queue';queue.mkdir(mode=0o700);app=self.root/'app';app.mkdir(mode=0o700);build=app/'BUILD_ID';build.write_bytes(b'fixture-build');build.chmod(0o600);lock=queue/'operations.lock';lock.write_bytes(b'');lock.chmod(0o600)
        credential={'protocol':'aihr-staging-queue/v1','candidate':'a'*40,'batch':'00000000-0000-4000-8000-000000000001','epoch':4,'token':'a'*64,'releaseAuthorized':False};plan={'source':'a'*40,'buildId':'fixture-build'}
        with sqlite3.connect(queue/'queue.sqlite3') as db:
            db.executescript('create table lease(singleton integer primary key,epoch integer,batch text,token_hash text,phase text,build text);create table batches(id text,plan text,state text);')
            db.execute('insert into lease values(1,?,?,?,?,?)',(4,credential['batch'],m.digest(credential['token'].encode()),'accepting','fixture-build'));db.execute('insert into batches values(?,?,?)',(credential['batch'],json.dumps({'candidate':plan['source']}),'leased'))
        (queue/'queue.sqlite3').chmod(0o600);return credential,plan,{'queue':queue,'app_root':app,'build_file':build}
    def test_real_queue_guard_holds_kernel_shared_lock_for_the_whole_maintenance(self):
        credential,plan,paths=self.queue_fixture()
        with m.lease_guard(credential,plan,**paths) as fence:
            fence();fd=os.open(paths['queue']/'operations.lock',os.O_RDONLY)
            try: self.assertRaises(BlockingIOError,fcntl.flock,fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            finally: os.close(fd)
        fd=os.open(paths['queue']/'operations.lock',os.O_RDONLY)
        try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        finally: os.close(fd)
    def test_real_queue_guard_refuses_foreign_source_token_epoch_and_unarrived_build(self):
        credential,plan,paths=self.queue_fixture()
        for key,value in [('candidate','b'*40),('epoch',5),('token','f'*64)]:
            bad={**credential,key:value}
            with self.assertRaises(ValueError):
                with m.lease_guard(bad,plan,**paths): self.fail('Foreign lease was admitted')
        with sqlite3.connect(paths['queue']/'queue.sqlite3') as db: db.execute("update lease set phase='installing'")
        with self.assertRaisesRegex(ValueError,'Accepted arrival'):
            with m.lease_guard(credential,plan,**paths): self.fail('Unarrived lease was admitted')
    def test_real_queue_guard_rechecks_actual_build_and_lease_before_later_steps(self):
        credential,plan,paths=self.queue_fixture()
        with m.lease_guard(credential,plan,**paths) as fence:
            paths['build_file'].write_bytes(b'foreign-build');self.assertRaisesRegex(ValueError,'Installed build differs',fence);paths['build_file'].write_bytes(b'fixture-build')
            with sqlite3.connect(paths['queue']/'queue.sqlite3') as db: db.execute('update lease set epoch=5')
            self.assertRaisesRegex(ValueError,'Foreign staging lease',fence)
    def test_actual_cli_refuses_non_root_before_reading_any_private_path(self):
        self.assertNotEqual(os.geteuid(),0,'Fixture runner must be unprivileged')
        p=subprocess.run([sys.executable,'-I',str(Path(m.__file__)),'--plan','/not-a-plan','--expected-plan-sha256','f'*64,'--lease','/not-a-lease','--apply'],capture_output=True,text=True)
        self.assertEqual(p.returncode,1);self.assertEqual(p.stdout,'');self.assertIn('Security maintenance refused',p.stderr);self.assertNotIn('Traceback',p.stderr);self.assertEqual(self.a.read_bytes(),b'original')

if __name__=='__main__': unittest.main()
