"""Real SQLite, subprocess contention and fencing tests. No application DB or remote target."""
import concurrent.futures
import contextlib
import json
import multiprocessing
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import uuid
from coordinator import Coordinator, PROTOCOL, canonical

BASE = 'a' * 40
CANDIDATE = 'b' * 40
STATE = dict(state='ok', stale_build='0', ref=BASE, built_ref=BASE, build_id='old', built_build_id='old')


def competing_claim(root, batch):
    c = Coordinator(root, lambda: dict(STATE))
    try:
        return c.request(dict(protocol=PROTOCOL, action='claim', actor='competing-session', batch=batch))
    except ValueError:
        return None
    finally:
        c.db.close()


def hold_operation(root, ready, done):
    c = Coordinator(root, lambda: dict(STATE))
    with c.operations():
        ready.set(); done.wait(10)
    c.db.close()


def orphan_operation(root, grant, marker):
    import sys
    c=Coordinator(root,lambda:dict(STATE))
    with c.operations() as fd:
        with c.transaction(): c.lease(grant)
        child=subprocess.Popen([sys.executable,'-c',"import pathlib,time;pathlib.Path(__import__('sys').argv[1]).write_text('started');time.sleep(3)",marker],pass_fds=(fd,),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        os._exit(0)  # Only this owned fixture launcher dies; the operation child must retain its lock.


class QueueTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name); self.root.chmod(0o700)
        self.state = dict(STATE)
        self.c = Coordinator(self.root, lambda: dict(self.state))

    def tearDown(self):
        self.c.db.close(); self.temp.cleanup()

    def request(self, action, **fields):
        return self.c.request(dict(protocol=PROTOCOL, actor='codex:test-session', action=action, **fields))

    def ticket(self, source=CANDIDATE, **updates):
        spec = dict(id=str(uuid.uuid4()), source=source, base=BASE, dependencies=[], risk='ordinary', migrations=[], acceptance='Rendered changed journey plus denied access', evidence='Original authenticated evidence reference')
        spec.update(updates)
        self.request('submit', spec=spec)
        return spec

    def batch(self, specs=None):
        specs = specs or [self.ticket()]
        return self.request('prepare', tickets=[s['id'] for s in specs], candidate=CANDIDATE, baseline=BASE, baselineBuild='old')['batch']

    def claim(self, batch=None):
        g = self.request('claim', batch=batch or self.batch())
        return {k:g[k] for k in ('batch', 'epoch', 'token', 'candidate')}

    def arrive(self, g):
        self.request('phase', **g, phase='installing')
        self.state.update(ref=CANDIDATE, built_ref=CANDIDATE, build_id='new', built_build_id='new')
        self.request('phase', **g, phase='arrived', build='new')
        self.request('phase', **g, phase='accepting', build='new')

    def test_two_ai_sessions_share_durable_state_and_atomic_claim(self):
        batch = self.batch([self.ticket('c'*40), self.ticket('d'*40)])
        with concurrent.futures.ProcessPoolExecutor(max_workers=4, mp_context=multiprocessing.get_context('spawn')) as pool:
            results = list(pool.map(competing_claim, [str(self.root)]*4, [batch]*4))
        grants = [g for g in results if g]
        self.assertEqual(len(grants), 1)
        second = Coordinator(self.root, lambda: self.state)
        try:
            status = second.request(dict(protocol=PROTOCOL, action='status', actor='claude:another-session'))
            self.assertEqual(status['lease']['batch'], batch)
            self.assertNotIn(grants[0]['token'], canonical(status))
            self.assertNotIn('token_hash', canonical(status))
        finally: second.db.close()

    def test_disconnect_does_not_expire_or_reclaim_lease(self):
        g = self.claim()
        self.c.db.execute('UPDATE events SET at=0')
        with self.assertRaises(ValueError): self.request('claim', batch=g['batch'])
        self.assertFalse(self.request('assert', **g)['releaseAuthorized'])

    def test_fencing_and_foreign_source_credentials(self):
        g = self.claim()
        for patch in (dict(token='0'*64), dict(epoch=g['epoch']+1), dict(candidate='f'*40), dict(batch=str(uuid.uuid4()))):
            with self.assertRaises(ValueError): self.request('assert', **{**g, **patch})
        self.request('abort', **g, reason='No staging mutation performed')
        newer = self.claim()
        self.assertGreater(newer['epoch'], g['epoch'])
        with self.assertRaises(ValueError): self.request('assert', **g)

    def test_dependency_readiness_and_isolated_changes(self):
        a = self.ticket(); b = self.ticket(dependencies=[a['id']])
        with self.assertRaises(ValueError): self.batch([b])
        self.request('block', id=a['id'], reason='Awaiting repair')
        with self.assertRaises(ValueError): self.batch([a,b])
        independent = self.ticket(); self.batch([independent])
        self.request('unblock', id=a['id'], reason='Focused repair complete')
        self.batch([a,b])
        for patch in (dict(migrations=['0699_example.sql']), dict(risk='isolated')):
            x = self.ticket(**patch); y = self.ticket()
            with self.assertRaises(ValueError): self.batch([x,y])

    def test_batch_limit_duplicates_and_immutable_ticket(self):
        a = self.ticket(); original = dict(a)
        self.request('submit', spec=original)
        with self.assertRaises(ValueError): self.request('submit', spec={**a, 'source':'e'*40})
        with self.assertRaises(ValueError): self.batch([a,a])
        with self.assertRaises(ValueError): self.batch([self.ticket() for _ in range(4)])

    def test_fifo_and_explicit_requeue_for_stale_baseline(self):
        a,b = self.batch(),self.batch()
        with self.assertRaises(ValueError): self.claim(b)
        self.state.update(build_id='moved', built_build_id='moved')
        with self.assertRaises(ValueError): self.claim(a)
        self.request('requeue', batch=a, reason='Baseline moved; prepare fresh integrated candidate')
        self.state.update(build_id='old', built_build_id='old')
        self.claim(b)

    def test_no_early_handback_and_actual_build_checks(self):
        g = self.claim()
        with self.assertRaises(ValueError): self.request('finish', **g, reason='Not accepted')
        with self.assertRaises(ValueError): self.request('phase', **g, phase='arrived', build='new')
        self.arrive(g)
        with self.assertRaises(ValueError): self.request('phase', **g, phase='claimed')
        self.state['built_build_id']='foreign'
        with self.assertRaises(ValueError): self.request('finish', **g, reason='Foreign build must refuse')
        self.state['built_build_id']='new'
        self.request('phase', **g, phase='capturing', build='new')
        result=self.request('finish', **g, reason='Acceptance evidence retained privately; capture complete')
        self.assertEqual(result['state'],'complete')
        self.assertFalse(result['releaseAuthorized'])

    def test_kernel_operation_lock_blocks_handback_and_recovery(self):
        g = self.claim(); self.arrive(g)
        ctx=multiprocessing.get_context('spawn'); ready=ctx.Event(); done=ctx.Event()
        child=ctx.Process(target=hold_operation,args=(str(self.root),ready,done));child.start()
        try:
            self.assertTrue(ready.wait(10))
            for action in ('finish','recover'):
                with self.assertRaises(BlockingIOError): self.request(action, **g, reason='Concurrent capture cannot release', acknowledgeUncertainAttempt=True, observedSource=CANDIDATE, observedBuild='new')
        finally: done.set();child.join(10)
        self.assertEqual(child.exitcode,0)
        self.request('finish', **g, reason='Capture subprocess finished')

    def test_orphan_operation_keeps_lock_after_launcher_dies(self):
        import time
        g=self.claim();marker=str(self.root/'child-started')
        child=multiprocessing.get_context('spawn').Process(target=orphan_operation,args=(str(self.root),g,marker));child.start();child.join(10)
        self.assertEqual(child.exitcode,0)
        deadline=time.monotonic()+2
        while not Path(marker).exists() and time.monotonic()<deadline:time.sleep(.01)
        self.assertTrue(Path(marker).exists())
        with self.assertRaises(BlockingIOError):self.request('abort',**g,reason='Child still owns operation')
        deadline=time.monotonic()+5
        while True:
            try:self.request('abort',**g,reason='Owned child completed');break
            except BlockingIOError:
                self.assertLess(time.monotonic(),deadline);time.sleep(.05)

    def test_recovery_requires_exact_identity_ack_and_healthy_observation(self):
        g=self.claim();self.request('phase',**g,phase='installing')
        with self.assertRaises(ValueError): self.request('abort',**g,reason='Unsafe automatic release')
        r={**g,'token':'lost','reason':'Operator checked detached operation, source checksum, ledger and service; evidence retained','observedSource':BASE,'observedBuild':'old'}
        with self.assertRaises(ValueError): self.request('recover',**r)
        self.state['state']='running'
        with self.assertRaises(ValueError): self.request('recover',**r,acknowledgeUncertainAttempt=True)
        self.state['state']='ok'
        self.assertEqual(self.request('recover',**r,acknowledgeUncertainAttempt=True)['state'],'failed')
        with self.assertRaises(ValueError):self.request('assert',**g)

    def test_private_state_refuses_symlinks_permissions_and_protocol(self):
        with self.assertRaises(ValueError):self.c.request(dict(protocol='foreign',action='status',actor='test'))
        self.root.chmod(0o755)
        with self.assertRaises(ValueError):Coordinator(self.root,lambda:self.state)
        self.root.chmod(0o700)
        self.c.db.close(); (self.root/'queue.sqlite3').unlink()
        (self.root/'queue.sqlite3').symlink_to(self.root/'operations.lock')
        with self.assertRaises(OSError):Coordinator(self.root,lambda:self.state)


if __name__ == '__main__': unittest.main()
