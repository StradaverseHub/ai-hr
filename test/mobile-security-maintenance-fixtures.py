"""Filesystem/refusal fixtures for the exact production transaction; no privileged paths or services."""
import base64, importlib.util, json, os, sqlite3, fcntl
from pathlib import Path
import subprocess, sys, tempfile, unittest
spec=importlib.util.spec_from_file_location('maintenance',Path(__file__).parents[1]/'deploy/security/maintenance.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

def recovery_changes(root):
    return [(root/('target'+str(i)),('new'+str(i)).encode(),0o644,m.digest(('old'+str(i)).encode()) if i<5 else None) for i in range(7)]

def recovery_ports(root):
    def read(p): return (m.regular(p,owner=os.getuid()),p.stat().st_mode&0o777) if p.exists() else None
    def write(p,value,mode):
        fd,name=tempfile.mkstemp(dir=p.parent)
        with os.fdopen(fd,'wb') as f: os.fchmod(f.fileno(),mode);f.write(value);f.flush();os.fsync(f.fileno())
        os.replace(name,p)
        fd=os.open(p.parent,os.O_RDONLY|os.O_DIRECTORY)
        try: os.fsync(fd)
        finally: os.close(fd)
    return {'read':read,'write':write,'remove':lambda p:p.unlink(),'fence':lambda:None,'prepare':lambda:None,'activate':lambda:None,'verify':lambda:None,'quiesce':lambda:None,'restore_services':lambda:None,'record':lambda phase,p:None,'backup':lambda i,b:write(root/(str(i)+'.before'),b,0o600),'backup_read':lambda i:m.regular(root/(str(i)+'.before'),owner=os.getuid()),'seal':lambda record:write(root/'recovery.json',(json.dumps(record)+'\n').encode(),0o600)}

def interrupt_fixture(root,cut):
    changes=recovery_changes(root);ports=recovery_ports(root)
    with m.operation_guard(root/'operation.lock',owner=os.getuid()):
        m.prepare_recovery(changes,ports,{'kind':'isolated-fixture-not-installation'})
        def prepare():
            m.require((root/'recovery.json').exists(),'Recovery must precede service stop')
            if cut==0: os._exit(73)
        write=ports['write'];count=0
        def interrupted_write(p,value,mode):
            nonlocal count
            write(p,value,mode);count+=1
            if count==cut: os._exit(73)  # SIGKILL-equivalent: no finally/rollback or post-write journal.
        ports.update(prepare=prepare,write=interrupted_write)
        m.apply_changes(changes,ports)
    raise AssertionError('Interruption point was not reached')

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
    def test_exclusive_lock_refuses_concurrent_apply_and_rollback_processes(self):
        lock=self.root/'operation.lock'
        script="import importlib.util,sys,os;from pathlib import Path;s=importlib.util.spec_from_file_location('m',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nwith m.operation_guard(Path(sys.argv[2]),owner=os.getuid()): print('UNEXPECTED_WRITER')"
        with m.operation_guard(lock,owner=os.getuid()):
            for intent in ['apply','rollback']:
                p=subprocess.run([sys.executable,'-I','-B','-c',script,str(Path(m.__file__)),str(lock),intent],capture_output=True,text=True)
                self.assertNotEqual(p.returncode,0);self.assertIn('BlockingIOError',p.stderr);self.assertEqual(p.stdout,'')
        with m.operation_guard(lock,owner=os.getuid()): pass
    def test_exclusive_lock_refuses_symlink_hardlink_or_writable_custody(self):
        lock=self.root/'operation.lock';lock.symlink_to(self.a)
        with self.assertRaises(OSError):
            with m.operation_guard(lock,owner=os.getuid()): self.fail('Symlink admitted')
        lock.unlink();os.link(self.a,lock)
        with self.assertRaises(ValueError):
            with m.operation_guard(lock,owner=os.getuid()): self.fail('Hardlink admitted')
        lock.unlink();lock.write_bytes(b'');lock.chmod(0o660)
        with self.assertRaises(ValueError):
            with m.operation_guard(lock,owner=os.getuid()): self.fail('Group write admitted')
    def test_recovery_seal_failure_precedes_all_target_writes_and_quiescence(self):
        ports={**self.ports,'backup':lambda i,b:None,'seal':lambda record:self.controlled_failure()}
        self.assertRaises(ValueError,m.prepare_recovery,self.changes,ports,{'kind':'fixture'})
        self.assertEqual(self.events,[]);self.assertEqual(self.a.read_bytes(),b'original');self.assertFalse(self.b.exists())
    def test_real_process_interruption_after_every_write_recovers_without_success_receipt(self):
        for cut in range(8):
            with self.subTest(interruption=cut):
                root=self.root/str(cut);root.mkdir()
                for i in range(5): p=root/('target'+str(i));p.write_bytes(('old'+str(i)).encode());p.chmod(0o640)
                process=subprocess.run([sys.executable,'-I','-B',str(Path(__file__).resolve()),'--interrupt',str(root),str(cut)],capture_output=True,text=True)
                self.assertEqual(process.returncode,73,process.stderr);self.assertEqual(process.stdout,'');self.assertFalse((root/'receipt.json').exists())
                recovery=json.loads((root/'recovery.json').read_text());self.assertEqual(len(recovery['files']),7)
                changes=recovery_changes(root);ports=recovery_ports(root)
                for i in range(cut): self.assertEqual((root/('target'+str(i))).read_bytes(),('new'+str(i)).encode())
                with m.operation_guard(root/'operation.lock',owner=os.getuid()): m.recover_changes(changes,recovery,ports)
                for i in range(5): self.assertEqual((root/('target'+str(i))).read_bytes(),('old'+str(i)).encode());self.assertEqual((root/('target'+str(i))).stat().st_mode&0o777,0o640)
                for i in range(5,7): self.assertFalse((root/('target'+str(i))).exists())
    def test_partial_recovery_refuses_foreign_files_before_any_restore(self):
        ports={**self.ports,'backup':lambda i,b:None,'seal':lambda record:None,'backup_read':lambda i:b'original'}
        recovery=m.prepare_recovery(self.changes,ports,{});self.a.write_bytes(b'replacement');self.b.write_bytes(b'foreign')
        self.assertRaisesRegex(ValueError,'foreign file changes',m.recover_changes,self.changes,recovery,ports)
        self.assertEqual(self.a.read_bytes(),b'replacement');self.assertEqual(self.b.read_bytes(),b'foreign');self.assertEqual(self.events,[])
    def test_partial_recovery_refuses_corrupt_preimage_and_incomplete_inventory(self):
        ports={**self.ports,'backup':lambda i,b:None,'seal':lambda record:None,'backup_read':lambda i:b'corrupt'}
        recovery=m.prepare_recovery(self.changes,ports,{})
        self.assertRaisesRegex(ValueError,'backup bytes differ',m.recover_changes,self.changes,recovery,ports)
        recovery['files'].pop();self.assertRaisesRegex(ValueError,'Complete recovery',m.recover_changes,self.changes,recovery,ports);self.assertEqual(self.events,[])

if __name__=='__main__':
    if len(sys.argv)>1 and sys.argv[1]=='--interrupt': interrupt_fixture(Path(sys.argv[2]),int(sys.argv[3]))
    else: unittest.main()
