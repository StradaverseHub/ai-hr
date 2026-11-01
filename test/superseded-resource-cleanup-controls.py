"""Isolated descriptor-engine and actual queue/FD controls; never touches staging or HR data."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('selected_engine', Path(__file__).resolve().parents[1] / '.github/ci/superseded-resource-cleanup.py')
tool = importlib.util.module_from_spec(spec); spec.loader.exec_module(tool)


class SupersededControls(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name); self.root.chmod(0o700)
        parent = self.root / '.aihr-ci-builds'; parent.mkdir(mode=0o700)
        self.old = parent / '64e902e7-ef86-4c6b-9a6e-75af7865fa0d'; self.old.mkdir(mode=0o700)
        self.source = self.root / 'source'; self.source.mkdir(mode=0o700)
        self.active = self.source / '.next'; self.active.mkdir()
        self.next = self.old / 'next'; self.next.mkdir()
        self.packet = self.old / 'packet'; self.packet.mkdir(mode=0o700)
        self.current_install = parent / 'efb9eea8-37e8-4fc5-a484-ff363d1e3890'; self.current_install.mkdir(mode=0o700)
        self.journal = self.root / 'operations'; self.journal.mkdir(mode=0o700)
        (self.active / 'BUILD_ID').write_text('current-2f6-build'); (self.next / 'BUILD_ID').write_text('retained-194e-build')
        grant = dict(source='old49', installId=self.old.name, baselineBuildId='retained-194e-build', build={'nextBuildId': 'old49-build'})
        data = (json.dumps(grant) + '\n').encode(); (self.old / 'authorization.json').write_bytes(data)
        self.protected = {'normal-cleanup.lock': b'ORIGINAL DEAD LOCK', 'normal-cleanup-ready.json': b'ORIGINAL READY', 'old-audit.json': b'ORIGINAL IMMUTABLE AUDIT'}
        for name, value in self.protected.items():
            (self.old / name).write_bytes(value)
        self.certificate = dict(certificateId='a' * 64, selection={'current': {'nextBuildId': 'current-2f6-build'}, 'obsolete': {**grant, 'nextBuildId': 'old49-build', 'retainedBuildId': 'retained-194e-build', 'grantSha256': hashlib.sha256(data).hexdigest()}},
                                targets={name: tool.identity(path.stat()) for name, path in [('active', self.active), ('currentInstall', self.current_install), ('oldInstall', self.old), ('next', self.next), ('packet', self.packet)]})
        self.events = []

    def tearDown(self):
        self.temp.cleanup()

    def check(self, remaining):
        self.events.append(('checked', list(remaining)))
        self.assert_preserved()

    def assert_preserved(self):
        for name, value in self.protected.items():
            self.assertEqual((self.old / name).read_bytes(), value)
        self.assertEqual((self.active / 'BUILD_ID').read_text(), 'current-2f6-build')

    def post(self):
        self.assert_preserved()
        return dict(kind='SUPERSEDED_RESOURCES_REMOVED_CURRENT_RUNTIME_VERIFIED', certificateSha256=tool.digest(self.certificate), verifiedAbsent=['next', 'packet'], originalLockReadyAndAuditsPreserved=True, originalOperatorExit=None, originalOperatorPass=False, releaseAuthorized=False)

    def run_engine(self, check=None, post=None, boundary=lambda name: None):
        return tool.remove_selected(self.old, self.source, self.journal, self.certificate, check or self.check, post or self.post, boundary)

    def test_different_current_and_obsolete_builds_remove_only_selected_children(self):
        inode = {name: (self.old / name).stat().st_ino for name in self.protected}
        result = self.run_engine()
        self.assertEqual(result['verifiedAbsent'], ['next', 'packet'])
        self.assertFalse(self.next.exists()); self.assertFalse(self.packet.exists())
        self.assert_preserved()
        self.assertEqual(inode, {name: (self.old / name).stat().st_ino for name in self.protected})
        self.assertTrue((self.journal / self.certificate['certificateId'] / 'result.json').is_file())
        self.assertEqual(self.events[0], ('checked', ['next', 'packet']))

    def test_wrong_second_child_refuses_before_first_delete_or_intent(self):
        self.certificate['targets']['packet']['inode'] += 1
        with self.assertRaises(ValueError):
            self.run_engine()
        self.assertTrue(self.next.exists()); self.assertTrue(self.packet.exists())
        self.assertEqual(list(self.journal.iterdir()), [])

    def test_active_alias_symlink_wrong_build_and_hardlinked_grant_refuse(self):
        for fault in ['active-alias', 'symlink', 'retained-build', 'grant-links']:
            with self.subTest(fault=fault):
                self.tearDown(); self.setUp()
                if fault == 'active-alias':
                    self.certificate['targets']['active'] = self.certificate['targets']['next']
                elif fault == 'symlink':
                    self.packet.rmdir(); self.packet.symlink_to(self.active, target_is_directory=True)
                elif fault == 'retained-build':
                    (self.next / 'BUILD_ID').write_text('foreign')
                else:
                    os.link(self.old / 'authorization.json', self.root / 'grant-alias')
                with self.assertRaises((ValueError, OSError)):
                    self.run_engine()
                self.assertTrue(self.next.exists()); self.assertEqual(list(self.journal.iterdir()), [])

    def test_current_active_replacement_is_detected_before_deletion(self):
        def drift(remaining):
            self.active.rename(self.source / 'former-active')
            self.active.mkdir(); (self.active / 'BUILD_ID').write_text('current-2f6-build')
        with self.assertRaises(ValueError):
            self.run_engine(check=drift)
        self.assertTrue(self.next.exists()); self.assertTrue(self.packet.exists())

    def test_partial_after_first_delete_retains_consumption_and_refuses_replay(self):
        def crash(name):
            if name == 'next':
                raise RuntimeError('simulated interrupted operation')
        with self.assertRaises(RuntimeError):
            self.run_engine(boundary=crash)
        operation = self.journal / self.certificate['certificateId']
        self.assertTrue((operation / 'consumed.json').is_file()); self.assertTrue((operation / 'removed-next.json').is_file())
        self.assertFalse((operation / 'result.json').exists()); self.assertFalse(self.next.exists()); self.assertTrue(self.packet.exists())
        with self.assertRaises(ValueError):
            self.run_engine()
        self.assert_preserved()

    def test_expiry_or_lease_drift_before_second_delete_retains_partial_scope(self):
        count = 0
        def changed(remaining):
            nonlocal count
            count += 1
            if count == 4:
                raise ValueError('actual boundary lease/certificate/source proof no longer valid')
        with self.assertRaises(ValueError):
            self.run_engine(check=changed)
        self.assertFalse(self.next.exists()); self.assertTrue(self.packet.exists()); self.assert_preserved()

    def test_post_audit_failure_never_fabricates_normal_cleanup_or_success(self):
        def failed():
            raise RuntimeError('CURRENT full runtime changed')
        with self.assertRaises(RuntimeError):
            self.run_engine(post=failed)
        self.assertFalse(self.next.exists()); self.assertFalse(self.packet.exists()); self.assert_preserved()
        self.assertFalse((self.journal / self.certificate['certificateId'] / 'result.json').exists())
        for name in ['cleanup-authorized.json', 'normal-cleanup-consumed.json', 'cleanup-result.json']:
            self.assertFalse((self.old / name).exists())

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


if __name__ == '__main__':
    unittest.main()
