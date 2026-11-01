"""Pure packet-only engine and actual inherited coordinator lease controls."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('remaining_engine',Path(__file__).resolve().parents[1]/'.github/ci/remaining-packet-cleanup.py')
tool=importlib.util.module_from_spec(spec);spec.loader.exec_module(tool)

class RemainingPacketControls(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.root.chmod(0o700)
        parent=self.root/'.aihr-ci-builds';parent.mkdir(mode=0o700)
        self.old=parent/'64e902e7-ef86-4c6b-9a6e-75af7865fa0d';self.old.mkdir(mode=0o700)
        self.source=self.root/'source';self.source.mkdir(mode=0o700)
        self.active=self.source/'.next';self.active.mkdir();(self.active/'BUILD_ID').write_text('current-build')
        self.packet=self.old/'packet';self.packet.mkdir(mode=0o700);(self.packet/'archive').write_bytes(b'fictional obsolete packet')
        self.next=self.old/'next'  # Historical removed child stays ABSENT.
        self.current=parent/'efb9eea8-37e8-4fc5-a484-ff363d1e3890';self.current.mkdir(mode=0o700)
        self.journal=self.root/'new-purpose';self.journal.mkdir(mode=0o700)
        self.partial=self.root/'original-partial';self.partial.mkdir(mode=0o700)
        grant=dict(source='old49',installId=self.old.name,baselineBuildId='old194e',build={'nextBuildId':'old49-build'})
        raw=(json.dumps(grant)+'\n').encode();(self.old/'authorization.json').write_bytes(raw)
        for name in ['normal-cleanup.lock','normal-cleanup-ready.json','audit.json']:(self.old/name).write_bytes(('original '+name).encode())
        for name in ['intent.json','consumed.json','removed-next.json']:(self.partial/name).write_bytes(('original partial '+name).encode())
        self.original={p:(p.stat().st_ino,p.read_bytes()) for directory in [self.old,self.partial] for p in directory.iterdir() if p.is_file()}
        self.certificate=dict(scope=['packet'],certificateId='a'*64,selection={'current':{'nextBuildId':'current-build'},'obsolete':{**grant,'nextBuildId':'old49-build','retainedBuildId':'old194e','grantSha256':hashlib.sha256(raw).hexdigest()}},targets={name:tool.identity(p.stat()) for name,p in [('active',self.active),('currentInstall',self.current),('oldInstall',self.old),('packet',self.packet)]})
        self.events=[]

    def tearDown(self):
        self.temp.cleanup()

    def preserved(self):
        for p,(inode,raw) in self.original.items():
            self.assertEqual(p.stat().st_ino,inode);self.assertEqual(p.read_bytes(),raw)
        self.assertEqual((self.active/'BUILD_ID').read_text(),'current-build')

    def check(self,remaining):
        self.events.append(list(remaining));self.preserved()

    def post(self):
        self.preserved()
        return dict(kind='REMAINING_PACKET_REMOVED_CURRENT_RUNTIME_VERIFIED',certificateSha256=tool.digest(self.certificate),verifiedAbsent=['packet'],originalPartialJournalPreserved=True,historicalNextStillAbsent=True,originalPartialAttemptExit=1,originalLockReadyAndAuditsPreserved=True,originalOperatorExit=None,originalOperatorPass=False,releaseAuthorized=False)

    def engine(self,check=None,post=None,boundary=lambda name:None):
        return tool.remove_packet(self.old,self.source,self.journal,self.certificate,check or self.check,post or self.post,boundary)

    def test_removes_only_remaining_packet_preserving_both_original_journals(self):
        result=self.engine();self.assertEqual(result['verifiedAbsent'],['packet']);self.assertFalse(self.packet.exists());self.assertFalse(self.next.exists());self.preserved()
        self.assertTrue((self.journal/self.certificate['certificateId']/'result.json').is_file())

    def test_wrong_packet_or_missing_packet_refuses_before_intent(self):
        self.certificate['targets']['packet']['inode']+=1
        with self.assertRaises(ValueError):self.engine()
        self.assertTrue(self.packet.exists());self.assertEqual(list(self.journal.iterdir()),[])
        self.packet.rename(self.old/'foreign')
        with self.assertRaises(ValueError):self.engine()
        self.assertEqual(list(self.journal.iterdir()),[])

    def test_next_reappearance_including_dangling_symlink_refuses(self):
        for kind in ['directory','dangling-symlink']:
            with self.subTest(kind=kind):
                self.tearDown();self.setUp()
                if kind=='directory':self.next.mkdir()
                else:self.next.symlink_to('missing')
                with self.assertRaises(ValueError):self.engine()
                self.assertTrue(self.packet.exists());self.assertEqual(list(self.journal.iterdir()),[])

    def test_alias_symlink_hardlinked_grant_and_expanded_scope_refuse(self):
        for fault in ['alias','symlink','grant-links','scope']:
            with self.subTest(fault=fault):
                self.tearDown();self.setUp()
                if fault=='alias':self.certificate['targets']['active']=self.certificate['targets']['packet']
                elif fault=='symlink':
                    self.packet.rename(self.old/'retained-packet');self.packet.symlink_to(self.active,target_is_directory=True)
                elif fault=='grant-links':os.link(self.old/'authorization.json',self.root/'alias')
                else:self.certificate['scope']=['next','packet']
                with self.assertRaises((ValueError,OSError)):self.engine()
                self.assertTrue(self.packet.exists());self.assertEqual(list(self.journal.iterdir()),[])

    def test_original_partial_drift_refuses_without_mutation(self):
        (self.partial/'consumed.json').write_bytes(b'changed')
        with self.assertRaises(AssertionError):self.engine()
        self.assertTrue(self.packet.exists());self.assertEqual(list(self.journal.iterdir()),[])

    def test_current_active_replacement_refuses_before_deletion(self):
        def drift(remaining):
            self.active.rename(self.source/'old-active');self.active.mkdir();(self.active/'BUILD_ID').write_text('current-build')
        with self.assertRaises(ValueError):self.engine(check=drift)
        self.assertTrue(self.packet.exists());self.assertEqual(list(self.journal.iterdir()),[])

    def test_expiry_or_lease_change_before_deletion_retains_consumption_and_packet(self):
        count=0
        def changed(remaining):
            nonlocal count
            count+=1
            if count==3:raise ValueError('actual fresh source/lease boundary refused')
        with self.assertRaises(ValueError):self.engine(check=changed)
        self.assertTrue(self.packet.exists());self.preserved()
        self.assertTrue((self.journal/self.certificate['certificateId']/'consumed.json').is_file())
        with self.assertRaises(ValueError):self.engine()

    def test_interruption_after_packet_delete_preserves_partial_and_refuses_replay(self):
        def crash(name):
            if name=='packet':raise RuntimeError('interrupted')
        with self.assertRaises(RuntimeError):self.engine(boundary=crash)
        self.assertFalse(self.packet.exists());self.preserved()
        op=self.journal/self.certificate['certificateId'];self.assertTrue((op/'removed-packet.json').exists());self.assertFalse((op/'result.json').exists())
        with self.assertRaises(ValueError):self.engine()

    def test_post_failure_never_fabricates_original_pass_or_new_success(self):
        def failed():raise RuntimeError('current runtime changed')
        with self.assertRaises(RuntimeError):self.engine(post=failed)
        self.assertFalse(self.packet.exists());self.preserved();self.assertFalse((self.journal/self.certificate['certificateId']/'result.json').exists())
        self.assertFalse((self.partial/'result.json').exists());self.assertFalse((self.old/'cleanup-result.json').exists())

    def actual_fd_chain(self, fault=None):
        """Real queue SQLite/EX -> Node actual remap export -> Python actual lease validator.

        Only the import-only Node execution port selects a temporary readonly wrapper. Production
        CLI paths, coordinator bootstrap and canonical checks have no environment/path override.
        """
        repository = Path(__file__).resolve().parents[1]
        module_spec = importlib.util.spec_from_file_location('fixture_actual_coordinator', repository / 'scripts/staging/coordinator.py')
        module = importlib.util.module_from_spec(module_spec)
        module_spec.loader.exec_module(module)
        queue = self.root / 'queue'
        queue.mkdir(mode=0o700)
        c = module.Coordinator(queue)
        source, batch, token = 'a' * 40, '11111111-1111-4111-8111-111111111111', 'f' * 64
        c.db.execute('INSERT INTO batches(id,plan,state) VALUES(?,?,?)', (batch, json.dumps({'candidate': source}), 'prepared'))
        c.db.execute('UPDATE lease SET epoch=13,batch=?,token_hash=?,phase=?', (batch, hashlib.sha256(token.encode()).hexdigest(), 'arrived'))
        wrapper = self.root / 'readonly-fd-validator.py'
        wrapper.write_text('''import importlib.util,sys
from pathlib import Path
sys.dont_write_bytecode=True
def load(name,path):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
tool=load('actual_custody',%s)
module=load('actual_coordinator',%s)
tool.OPERATIONS=Path(%s)/'operations.lock'
c=module.Coordinator(Path(%s))
tool.assert_exclusive_lease(module,c)
''' % (repr(str(repository / '.github/ci/superseded-resource-cleanup.py')), repr(str(repository / 'scripts/staging/coordinator.py')), repr(str(queue)), repr(str(queue))))
        node_program = '''import {execFileSync} from 'node:child_process';
import {assertExclusiveLease} from %s;
try {assertExclusiveLease((command,args,options)=>{
 if(command!=='python3'||args[1]!=='assert-exclusive')throw Error('Unexpected production validator invocation');
 const altered=%s==='remapped-fd'?{...options,stdio:options.stdio.slice(0,3)}:options;
 return execFileSync(command,%s==='child-failure'?['-c','raise RuntimeError("bounded fixture failure")']:[%s],altered);
});process.stdout.write('CHAIN_OK\\n');}catch{process.stderr.write('CHAIN_REFUSED\\n');process.exitCode=1;}
''' % (json.dumps((repository / '.github/ci/superseded-resource-bridge.mjs').as_uri()), json.dumps(fault), json.dumps(fault), json.dumps(str(wrapper)))
        environment = {**os.environ, 'AIHR_STAGING_BATCH': batch, 'AIHR_STAGING_EPOCH': '13', 'AIHR_STAGING_TOKEN': token,
                       'AIHR_STAGING_CANDIDATE': source, 'PYTHONDONTWRITEBYTECODE': '1'}
        try:
            with c.operations(exclusive=fault != 'shared-other-description') as fd:
                with c.transaction():
                    c.lease({**module.environment_request(), 'batch': batch, 'epoch': 13, 'candidate': source, 'token': token})
                extra = None
                if fault in ['wrong-inode', 'shared-other-description']:
                    chosen = self.root / 'unrelated.lock' if fault == 'wrong-inode' else queue / 'operations.lock'
                    if fault == 'wrong-inode':
                        chosen.write_bytes(b'')
                        chosen.chmod(0o600)
                    extra = os.open(chosen, os.O_RDWR)
                forwarded = fd if extra is None else extra
                environment['AIHR_SUPERSEDED_EXCLUSIVE_FD'] = str(forwarded)
                if fault == 'missing-fd':
                    environment.pop('AIHR_SUPERSEDED_EXCLUSIVE_FD')
                if fault == 'wrong-token':
                    environment['AIHR_STAGING_TOKEN'] = 'e' * 64
                if fault == 'wrong-epoch':
                    environment['AIHR_STAGING_EPOCH'] = '14'
                if fault == 'wrong-source':
                    environment['AIHR_STAGING_CANDIDATE'] = 'b' * 40
                try:
                    result = subprocess.run(['node', '--input-type=module', '--eval', node_program], env=environment,
                                            pass_fds=(forwarded,), capture_output=True, timeout=20)
                    if fault is None:
                        self.assertEqual(result.returncode, 0, result.stderr.decode())
                        self.assertEqual(result.stdout, b'CHAIN_OK\n')
                    else:
                        self.assertNotEqual(result.returncode, 0)
                        self.assertIn(b'CHAIN_REFUSED', result.stderr)
                    self.assertNotIn(token.encode(), result.stdout + result.stderr)
                    # Children cannot release the parent's still-held actual coordinator lock.
                    with self.assertRaises(BlockingIOError):
                        with c.operations(exclusive=True):
                            self.fail('Parent operation lock was lost during the child chain')
                finally:
                    if extra is not None:
                        os.close(extra)
            # Parent and child descriptors are all closed: the real kernel lock is now available.
            with c.operations(exclusive=True):
                pass
        finally:
            c.db.close()

    def test_actual_coordinator_node_python_fd_chain_retains_then_releases_exclusive_lock(self):
        self.actual_fd_chain()

    def test_actual_fd_chain_refuses_missing_wrong_inode_remap_and_shared_description(self):
        for fault in ['missing-fd', 'wrong-inode', 'remapped-fd', 'shared-other-description']:
            with self.subTest(fault=fault):
                self.tearDown()
                self.setUp()
                self.actual_fd_chain(fault)

    def test_actual_fd_chain_refuses_changed_lease_and_bounded_child_failure(self):
        for fault in ['wrong-token', 'wrong-epoch', 'wrong-source', 'child-failure']:
            with self.subTest(fault=fault):
                self.tearDown()
                self.setUp()
                self.actual_fd_chain(fault)


if __name__=='__main__':unittest.main()
