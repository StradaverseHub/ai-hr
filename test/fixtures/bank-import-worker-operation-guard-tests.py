"""Actual hosted-Linux kernel lock lifetime plus fixed guard authority refusals. No services/root/network."""
import fcntl
import hashlib
import importlib.util
import json
import os
import pwd
from pathlib import Path
import select
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('operation_guard',ROOT/'deploy/systemd/bank_import_worker_operation_guard_v1.py')
guard=importlib.util.module_from_spec(spec);spec.loader.exec_module(guard)

def check(ok,message):
    if not ok:raise ValueError(message)

def pins(queue):
    lock=queue/'operations.lock';q=queue.stat();s=lock.stat()
    return {'policy':guard.GUARD_POLICY,'queueDirectory':str(queue),'lockPath':str(lock),'uid':s.st_uid,'gid':s.st_gid,
            'mode':0o600,'device':s.st_dev,'inode':s.st_ino,'queueMode':0o700,'queueDevice':q.st_dev,'queueInode':q.st_ino}

def queue_lock(queue):
    # Only path constants are fixture ports. Real open/flock/fdinfo/named inode checks execute unchanged.
    guard.QUEUE=queue;guard.LOCK=queue/'operations.lock'
    return guard.QueueOperationLock(SimpleNamespace(check=check),pins(queue))

def held_guard(queue,install):
    result=guard.GuardedInvocation.__new__(guard.GuardedInvocation)
    result.base=SimpleNamespace(check=check,root_protected=lambda *a,**k:None)
    result.lock=queue_lock(queue)
    result.verify=lambda:result.lock.verify()
    result.install_fd=os.open(install,os.O_RDWR|os.O_NOFOLLOW)
    fcntl.flock(result.install_fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    s=os.fstat(result.install_fd);result.install_path=install;result.install_identity=(s.st_dev,s.st_ino)
    return result

HOLD_CHILD="""import os,sys,time
print('MUTATION_CHILD_READY',flush=True)
os.read(int(sys.argv[1]),1)
"""

def holder(queue,install,release_fd,readonly=False):
    g=held_guard(Path(queue),Path(install))
    if readonly:
        # A true read-only leaf receives no authority FDs, performs no publication and has no guard/token.
        child=subprocess.Popen([sys.executable,'-I','-B','-c',HOLD_CHILD,str(release_fd)],pass_fds=(release_fd,))
    else:
        child=subprocess.Popen([sys.executable,'-I','-B','-c',HOLD_CHILD,str(release_fd)],pass_fds=(*g.inherited_fds(),release_fd))
    print(json.dumps({'parent':os.getpid(),'child':child.pid}),flush=True)
    child.wait()

class KernelTests(unittest.TestCase):
    def setUp(self):
        self.assertEqual(sys.platform,'linux','This mandatory kernel fixture is hosted Linux only')
        self.assertGreater(os.getuid(),0,'Use standard unprivileged hosted runner')
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.queue=self.root/'queue';self.queue.mkdir(mode=0o700)
        self.operation=self.queue/'operations.lock';self.operation.touch(mode=0o600)
        self.install=self.root/'install.lock';self.install.touch(mode=0o600)
        self.oldqueue,self.oldlock=guard.QUEUE,guard.LOCK
    def tearDown(self):
        guard.QUEUE,guard.LOCK=self.oldqueue,self.oldlock;self.tmp.cleanup()
    def try_ex(self,path):
        fd=os.open(path,os.O_RDWR|os.O_NOFOLLOW)
        try:
            try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);return True
            except BlockingIOError:return False
        finally:os.close(fd)
    def test_actual_shared_lock_blocks_exclusive_handoff_until_close(self):
        q=queue_lock(self.queue)
        try:self.assertFalse(self.try_ex(self.operation));self.assertEqual(q.verify(),q.fd)
        finally:q.close()
        self.assertTrue(self.try_ex(self.operation))
    def test_inherited_shared_description_survives_original_close(self):
        q=queue_lock(self.queue);duplicate=os.dup(q.fd);q.close()
        try:self.assertFalse(self.try_ex(self.operation))
        finally:os.close(duplicate)
        self.assertTrue(self.try_ex(self.operation))
    def test_duplicate_unlock_invalidates_actual_shared_guard_without_inode_change(self):
        q=queue_lock(self.queue);duplicate=os.dup(q.fd);before=self.operation.stat()
        try:
            fcntl.flock(duplicate,fcntl.LOCK_UN)
            after=self.operation.stat()
            self.assertEqual((before.st_dev,before.st_ino),(after.st_dev,after.st_ino))
            self.assertTrue(self.try_ex(self.operation),'Kernel SH was actually removed by inherited duplicate')
            with self.assertRaisesRegex(ValueError,'shared operation lock is not held'):q.verify()
        finally:
            # Close only; never unlock a possibly inherited surviving open description.
            os.close(duplicate);q.close()
    def test_named_inode_replacement_refuses_even_while_original_is_locked(self):
        q=queue_lock(self.queue)
        try:
            self.operation.rename(self.queue/'old');self.operation.touch(mode=0o600)
            with self.assertRaisesRegex(ValueError,'identity changed'):q.verify()
        finally:q.close()
    def test_mode_and_hardlink_changes_refuse(self):
        q=queue_lock(self.queue)
        try:
            self.operation.chmod(0o640)
            with self.assertRaises(ValueError):q.verify()
            self.operation.chmod(0o600);os.link(self.operation,self.queue/'alias')
            with self.assertRaises(ValueError):q.verify()
        finally:q.close()
    def test_verifier_does_not_create_missing_native_lock(self):
        self.operation.unlink();guard.QUEUE=self.queue;guard.LOCK=self.operation
        with self.assertRaises(FileNotFoundError):guard.QueueOperationLock(SimpleNamespace(check=check),{'policy':guard.GUARD_POLICY,'queueDirectory':str(self.queue),'lockPath':str(self.operation),'uid':os.getuid(),'gid':os.getgid(),'mode':0o600,'device':1,'inode':1,'queueMode':0o700,'queueDevice':self.queue.stat().st_dev,'queueInode':self.queue.stat().st_ino})
        self.assertFalse(self.operation.exists())
    def test_both_verified_descriptions_are_inherited(self):
        g=held_guard(self.queue,self.install)
        try:
            self.assertEqual(g.inherited_fds(),(g.lock.fd,g.install_fd))
            self.assertFalse(self.try_ex(self.operation));self.assertFalse(self.try_ex(self.install))
        finally:os.close(g.install_fd);g.close()
    def orphan(self,readonly):
        read,write=os.pipe();p=subprocess.Popen([sys.executable,'-I','-B',str(Path(__file__).resolve()),'--holder',str(self.queue),str(self.install),str(read),str(int(readonly))],pass_fds=(read,),stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        os.close(read);child=None;child_fd=None
        try:
            data=b'';deadline=time.monotonic()+10
            while time.monotonic()<deadline and data.count(b'\n')<2:
                self.assertTrue(select.select([p.stdout],[],[],max(.01,deadline-time.monotonic()))[0],'Holder readiness timeout')
                block=os.read(p.stdout.fileno(),4096);self.assertTrue(block,'Holder exited before readiness');data+=block
            lines=data.decode().splitlines()
            row=next(json.loads(x)for x in lines if x.startswith('{'));child=row['child'];child_fd=os.pidfd_open(child)
            self.assertIn('MUTATION_CHILD_READY',lines)
            self.assertFalse(self.try_ex(self.operation));self.assertFalse(self.try_ex(self.install))
            p.kill();p.wait(timeout=5)
            # A mutation-capable direct child keeps BOTH kernel descriptions after root/launcher death.
            self.assertEqual(self.try_ex(self.operation),readonly);self.assertEqual(self.try_ex(self.install),readonly)
            os.write(write,b'x');os.close(write);write=None
            deadline=time.monotonic()+5
            while time.monotonic()<deadline and (not self.try_ex(self.operation)or not self.try_ex(self.install)):time.sleep(.01)
            self.assertTrue(self.try_ex(self.operation));self.assertTrue(self.try_ex(self.install))
            # No acceptance/success artifact or next mutating step exists in the read-only child.
            self.assertEqual(set(x.name for x in self.root.iterdir()),{'queue','install.lock'})
        finally:
            if write is not None:os.close(write)
            if p.poll()is None:p.kill();p.wait(timeout=5)
            if child_fd is not None:
                try:signal.pidfd_send_signal(child_fd,signal.SIGTERM)
                except ProcessLookupError:pass
                finally:os.close(child_fd)
            p.stdout.close();p.stderr.close()
    def test_sigkill_parent_mutating_child_retains_sh_and_ex_until_last_exit(self):self.orphan(False)
    def test_readonly_orphan_has_no_authority_fds_or_success_continuation(self):self.orphan(True)

class BoundaryTests(unittest.TestCase):
    def obj(self):
        o=guard.GuardedInvocation.__new__(guard.GuardedInvocation);o.base=SimpleNamespace(check=check);o.install_fd=9;o.events=[];o.stage='activate-ci-runtime'
        o.verify=lambda:o.events.append('SH');o.verify_install=lambda:o.events.append('EX');o.a={'issuedAt':'start','expiresAt':'end','dotenvSha256':'web'}
        o.ci=SimpleNamespace(epoch=lambda s:0 if s=='start'else 1000,SOURCE=Path('/web'),sha=lambda b:b.decode())
        o.identity={'worker_env_sha256':'worker'};o.base.ENV=Path('/worker');o.base.read_bounded=lambda path,limit:b'web'if str(path).startswith('/web')else b'worker'
        o.native_lease=lambda:o.events.append('native-lease');return o
    def test_before_mutation_requires_fresh_lease_and_both_locks(self):
        o=self.obj()
        with patch.object(guard.time,'time',return_value=10):o.file_mutation()
        self.assertEqual(o.events,['EX','SH','EX','native-lease'])
    def test_expiry_and_lease_failure_prevent_publication(self):
        for failure in ['expiry','lease']:
            o=self.obj();writes=[]
            if failure=='lease':o.native_lease=lambda:(_ for _ in()).throw(ValueError('lease refused'))
            with patch.object(guard.time,'time',return_value=1001 if failure=='expiry'else 10):
                with self.assertRaises(ValueError):o.file_mutation();writes.append('success')
            self.assertEqual(writes,[])
    def test_guarded_drain_uses_native_owner_environment_and_readiness_before_mutation(self):
        o=self.obj();o.stage='drain';o.base.NODE=Path('/node');o.owner=object();o.environment={'controlled':'yes'};o.lock=SimpleNamespace(fd=4)
        o.a.update(environmentSha256='canonical',readiness={'required':'1','waitSeconds':None})
        result={'kind':'CI_WORKER_DRAIN_ENVIRONMENT_POLICY_V1','environmentSha256':'canonical','readiness':o.a['readiness']}
        seen=[]
        def child(argv,owner,environment,**options):
            seen.append(argv);self.assertIs(owner,o.owner);self.assertEqual(environment,o.environment);self.assertEqual(options['operation_fd'],4);return result
        o.ci.child=child
        with patch.object(guard.time,'time',return_value=10):o.file_mutation()
        self.assertEqual(seen[0],['/node','--env-file=.env.production','--input-type=module','-e',guard.DRAIN_ENVIRONMENT_PROBE])
        result['environmentSha256']='changed-service-config'
        with patch.object(guard.time,'time',return_value=10):
            with self.assertRaisesRegex(ValueError,'environment/readiness differs'):o.file_mutation()
    def test_failure_only_requires_owned_start_without_fresh_lease_pass(self):
        o=self.obj();o.observer=SimpleNamespace(quarantine_fence=lambda:o.events.append('own-start'))
        o.native_lease=lambda:(_ for _ in()).throw(AssertionError('must not claim failed lease PASS'))
        o.file_mutation(failure_only=True);self.assertEqual(o.events,['EX','own-start'])
        o.observer=None
        with self.assertRaisesRegex(ValueError,'owned-start'):o.file_mutation(failure_only=True)
    def test_node_pin_is_checked_in_guard_verify_without_activation_observer(self):
        with tempfile.TemporaryDirectory()as tmp:
            r=Path(tmp);node=r/'node';node.write_bytes(b'approved-node-v22.23.3');coordinator=r/'coordinator';coordinator.write_bytes(b'fixed-owner')
            approval=r/'approval';approval.write_bytes(b'approval');lease=r/'lease';lease.write_bytes(b'lease')
            o=guard.GuardedInvocation.__new__(guard.GuardedInvocation);o.lock=SimpleNamespace(fd=3,verify=lambda:3)
            sha=lambda b:hashlib.sha256(b).hexdigest();o.base=SimpleNamespace(check=check,root_protected=lambda *a,**kw:None,NODE=node,read_bounded=lambda p,n:p.read_bytes())
            o.ci=SimpleNamespace(sha=sha,COORDINATOR=coordinator,protected_private=lambda b,p:(p.stat().st_dev,p.stat().st_ino))
            o.path=approval;o.bytes=b'approval';o.approval_identity=o.ci.protected_private(None,approval);o.lease_path=lease;o.lease_identity=o.ci.protected_private(None,lease)
            o.a={'leaseFileSha256':sha(b'lease'),'coordinatorSha256':sha(b'fixed-owner'),'nodeSha256':sha(node.read_bytes())}
            self.assertEqual(o.verify(),3);node.write_bytes(b'different-node-v22.23.3')
            with self.assertRaisesRegex(ValueError,'approved Node'):o.verify()

def privilege_child(sh,ex,release,uid,gid,expected):
    assert os.getuid()==os.geteuid()==uid>0 and os.getgid()==os.getegid()==gid and os.getgroups()==[]
    assert set(os.environ)<= {'PATH','LANG','LC_CTYPE'} and os.environ['PATH']=='/usr/bin:/bin'
    found=[]
    for fd,kind in [(sh,'READ'),(ex,'WRITE')]:
        info=os.fstat(fd);found.append([info.st_dev,info.st_ino,info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode)])
        assert any(row.split()[2:5]==['FLOCK','ADVISORY',kind]for row in Path('/proc/self/fdinfo/'+str(fd)).read_text().splitlines()if row.startswith('lock:'))
    assert found==expected and found[0][2]==uid and found[1][2]==0
    try:guard.launch(['guarded-drain','--approval','/nonexistent-fixture-approval','--approval-sha256','0'*64],None,SimpleNamespace(check=check),None,None)
    except ValueError as error:assert 'privilege boundary' in str(error)
    else:raise AssertionError('Nonroot fixed launcher must refuse before reading approval')
    print(json.dumps({'kind':'ACTUAL_ROOT_TO_OWNER_KERNEL_BOUNDARY','uid':uid,'gid':gid,'supplementaryGroups':os.getgroups(),'verifiedLocks':found,'rootLauncherRefused':True}),flush=True)
    os.read(release,1)

def privilege_boundary(uid,gid):
    assert sys.platform=='linux' and os.geteuid()==0 and uid>0 and pwd.getpwuid(uid).pw_gid==gid
    temporary=tempfile.TemporaryDirectory(prefix='aihr-worker-guard-uid-',dir='/tmp');root=Path(temporary.name)
    assert root.parent==Path('/tmp') and root.name.startswith('aihr-worker-guard-uid-') and root.is_dir() and not root.is_symlink()
    initial=(root.stat().st_dev,root.stat().st_ino);os.chown(root,uid,gid);root.chmod(0o700)
    queue=root/'queue';queue.mkdir(mode=0o700);os.chown(queue,uid,gid)
    native=queue/'operations.lock';native.touch(mode=0o600);os.chown(native,uid,gid)
    install=root/'install.lock';install.touch(mode=0o600)
    oldqueue,oldlock=guard.QUEUE,guard.LOCK;g=None;child=None;read=write=None
    def available(path):
        fd=os.open(path,os.O_RDWR|os.O_NOFOLLOW)
        try:
            try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);return True
            except BlockingIOError:return False
        finally:os.close(fd)
    try:
        g=held_guard(queue,install);fds=g.inherited_fds()
        expected=[]
        for fd in fds:
            i=os.fstat(fd);expected.append([i.st_dev,i.st_ino,i.st_uid,i.st_gid,stat.S_IMODE(i.st_mode)])
        read,write=os.pipe()
        child=subprocess.Popen([sys.executable,'-I','-B',str(Path(__file__).resolve()),'--uid-child',str(fds[0]),str(fds[1]),str(read),str(uid),str(gid),json.dumps(expected)],cwd=root,env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'},user=uid,group=gid,extra_groups=[],pass_fds=(*fds,read),stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        os.close(read);read=None
        assert select.select([child.stdout],[],[],15)[0],'Actual UID child readiness deadline'
        line=child.stdout.readline();assert line,child.stderr.read();proof=json.loads(line)
        assert proof['kind']=='ACTUAL_ROOT_TO_OWNER_KERNEL_BOUNDARY'
        os.close(g.install_fd);g.close();g=None
        assert not available(native) and not available(install),'Privilege child must retain BOTH actual descriptions'
        os.write(write,b'x');os.close(write);write=None
        output,error=child.communicate(timeout=10);assert child.returncode==0,error
        assert available(native) and available(install),'Last close releases both locks'
        print(json.dumps({**proof,'parentDescriptionsClosed':True,'childHeldBothUntilExit':True,'mutationsOutsideOwnedTempfiles':False,'servicesTouched':False,'releaseAuthorized':False}))
    finally:
        if child is not None:
            if child.poll()is None:child.kill();child.wait(timeout=5)
            if child.stdout:child.stdout.close()
            if child.stderr:child.stderr.close()
        for fd in [read,write]:
            if fd is not None:os.close(fd)
        if g is not None:os.close(g.install_fd);g.close()
        guard.QUEUE,guard.LOCK=oldqueue,oldlock
        assert(root.stat().st_dev,root.stat().st_ino)==initial and not root.is_symlink()
        temporary.cleanup()

if __name__=='__main__':
    if sys.argv[1:2]==['--holder']:holder(sys.argv[2],sys.argv[3],int(sys.argv[4]),bool(int(sys.argv[5])))
    elif sys.argv[1:2]==['--privilege-boundary']:privilege_boundary(int(sys.argv[2]),int(sys.argv[3]))
    elif sys.argv[1:2]==['--uid-child']:privilege_child(*map(int,sys.argv[2:7]),json.loads(sys.argv[7]))
    else:unittest.main()
