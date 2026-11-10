"""Synthetic process and publication controls. No application or Docker."""
import json
import os
from pathlib import Path
import select
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from types import ModuleType

path = Path(__file__).with_name('worker-comparison-family.py')
owner = ModuleType('worker_comparison_family')
owner.__file__ = str(path)
exec(compile(path.read_bytes(), str(path), 'exec', dont_inherit=True), owner.__dict__)


class FamilyTests(unittest.TestCase):
    course = 'serial-2-4-8'

    def setUp(self):
        course = patch.dict(os.environ, {'AIHR_MEASURED_BROWSER_COURSE': self.course})
        course.start()
        self.addCleanup(course.stop)

    def test_exact_order_and_real_channel(self):
        parent, client = socket.socketpair()
        descriptor, finished = os.pipe()
        responses = []

        def child():
            for frame in (b'H\n', b'B1\n', b'B2\n', b'B3\n'):
                client.sendall(frame)
                responses.append(client.recv(8))
            os.write(finished, b'X')

        with parent, client:
            client.settimeout(2)
            thread = threading.Thread(target=child)
            thread.start()
            try:
                with patch.object(owner, 'barrier') as barrier:
                    self.assertEqual(owner.exchange(parent, descriptor, 71, 951, owner.clock()), 4)
                    self.assertEqual(barrier.call_count, 4)
            finally:
                thread.join(3)
                os.close(descriptor)
                os.close(finished)
        self.assertEqual(responses, [b'A0\n', b'A1\n', b'A2\n', b'A3\n'])

    def test_refuses_skipped_ordinal_before_acknowledgement(self):
        parent, client = socket.socketpair()
        descriptor, finished = os.pipe()
        try:
            with parent, client, patch.object(owner, 'barrier') as barrier:
                client.sendall(b'B2\n')
                with self.assertRaises(ValueError):
                    owner.exchange(parent, descriptor, 71, 951, owner.clock())
                barrier.assert_not_called()
        finally:
            os.close(descriptor)
            os.close(finished)

    def test_closed_family_diagnostic_distinguishes_frame_from_barrier(self):
        secret = '/private/fixture; select tenant_id'
        self.assertEqual(owner.failure_fact(secret, True),
                         {'kind': 'WORKER_COMPARISON_FAMILY_FAILURE_V1', 'stage': 'unavailable', 'ordinal': None,
                          'barrierCheck': None, 'observedChildren': None})
        for frame, stage in ((b'B2\n', 'family-frame'), (b'H\n', 'family-barrier')):
            parent, client = socket.socketpair()
            descriptor, finished = os.pipe()
            marks = []
            try:
                with parent, client, patch.object(owner, 'barrier', side_effect=ValueError(secret)):
                    client.sendall(frame)
                    with self.assertRaises(ValueError):
                        owner.exchange(parent, descriptor, 71, 951, owner.clock(),
                                       lambda *value: marks.append(value))
                self.assertEqual(owner.failure_fact(*marks[-1]),
                                 {'kind': 'WORKER_COMPARISON_FAMILY_FAILURE_V1', 'stage': stage, 'ordinal': 0,
                                  'barrierCheck': None, 'observedChildren': None})
            finally:
                os.close(descriptor)
                os.close(finished)

    def test_refuses_unknown_child_or_adopted_process(self):
        with patch.object(owner, 'exact_child') as exact:
            for direct, adopted in (([16], [71]), ([], [71, 16])):
                with patch.object(owner, 'children_of', return_value=direct), patch.object(owner.KERNEL, 'own_children', return_value=adopted), \
                        patch.object(owner, 'reap_exited_adoptees', side_effect=ValueError('unverified adoptee')):
                    with self.assertRaises(ValueError):
                        owner.barrier(71, 9, 951)
            with patch.object(owner, 'children_of', return_value=[]), patch.object(owner.KERNEL, 'own_children', return_value=[71]):
                owner.barrier(71, 9, 951)
            self.assertEqual(exact.call_count, 4)

    def test_barrier_subreason_distinguishes_adopted_direct_and_refused_scan(self):
        cases = (
            ([71, 997], [], 'owner-census-before', 2),
            ([71], [997], 'runner-descendant-census', 1),
            ([71], OSError('untrusted private process path'), 'runner-descendant-census', None),
        )
        for adopted, descendants, check, count in cases:
            values = []
            def observe(*value):
                values.append(value)
            with patch.object(owner, 'exact_child'), patch.object(owner.KERNEL, 'own_children', return_value=adopted), \
                    patch.object(owner, 'children_of', return_value=descendants if isinstance(descendants, list) else [],
                                 side_effect=descendants if isinstance(descendants, Exception) else None), \
                    patch.object(owner, 'reap_exited_adoptees', side_effect=ValueError('unverified adoptee')), \
                    patch.object(owner.signal, 'pidfd_send_signal', create=True) as signal:
                with self.assertRaises((ValueError, OSError)):
                    owner.barrier(71, 9, 951, observe)
                signal.assert_not_called()
            fact = owner.failure_fact('family-barrier', 1, *values[-1])
            self.assertEqual((fact['barrierCheck'], fact['observedChildren']), (check, count))
            self.assertNotIn('997', str(fact))

    def test_refuses_identity_and_descriptor_faults_before_consuming_child_exit(self):
        pid, runner = 997, 71
        before = {'pid': pid, 'parent': os.getpid(), 'state': 'Z', 'session': runner, 'group': runner, 'start': 20}
        read = owner.os.WEXITED | owner.os.WNOHANG | owner.os.WNOWAIT
        wrong = type('Status', (), {'si_pid': pid + 1})()
        for identities, opening, result, calls in (
            ([dict(before, parent=100)], 9, wrong, []),
            ([dict(before, session=100)], 9, wrong, []),
            ([dict(before, state='S')], 9, wrong, []),
            ([before], OSError('descriptor unavailable'), wrong, []),
            ([before, dict(before, start=21)], 9, wrong, []),
            ([before, before], 9, None, [(5, 9, read)]),
            ([before, before], 9, wrong, [(5, 9, read)]),
        ):
            with patch.object(owner.KERNEL, 'identity', side_effect=identities), \
                    patch.object(owner.os, 'P_PIDFD', 5, create=True), \
                    patch.object(owner.os, 'pidfd_open', return_value=9,
                                 side_effect=opening if isinstance(opening, Exception) else None, create=True), \
                    patch.object(owner.os, 'waitid', return_value=result, create=True) as wait, \
                    patch.object(owner.os, 'close') as close, \
                    patch.object(owner.signal, 'pidfd_send_signal', create=True) as send:
                with self.assertRaises((ValueError, OSError)):
                    owner.reap_exited_adoptees(runner, [pid])
                self.assertEqual([call.args for call in wait.call_args_list], calls)
                self.assertEqual(close.call_count, int(len(identities) > 1))
                send.assert_not_called()

    @unittest.skipUnless(sys.platform == 'linux', 'real Linux pidfd and subreaper')
    def test_native_reaps_already_exited_adoptee_and_keeps_live_or_escaped_children_refused(self):
        helper = """
import os
import sys

mode = sys.argv[1]
read, release = os.pipe()
parent = os.fork()
if parent == 0:
    target = os.fork()
    if target == 0:
        os.close(release)
        if mode == 'live':
            os.read(read, 1)
        if mode == 'escaped':
            os.setsid()
        os._exit(0)
    if mode != 'live':
        os.waitid(os.P_PID, target, os.WEXITED | os.WNOWAIT)
    os._exit(0)
os.close(read)
os.waitpid(parent, 0)
print('ready', flush=True)
sys.stdin.buffer.read()
os.close(release)
"""
        kernel = owner.KERNEL
        self.assertEqual(kernel.own_children(), [])
        previous = kernel.subreaper(True)
        try:
            for mode in ('exited', 'live', 'escaped'):
                runner = subprocess.Popen([sys.executable, '-c', helper, mode],
                                          stdin=subprocess.PIPE, stdout=subprocess.PIPE, start_new_session=True)
                descriptor = os.pidfd_open(runner.pid)
                adopted_descriptor = None
                try:
                    self.assertTrue(select.select([runner.stdout], [], [], 3)[0])
                    self.assertEqual(runner.stdout.readline(), b'ready\n')
                    birth = kernel.identity(runner.pid)['start']
                    adopted, = [pid for pid in kernel.own_children() if pid != runner.pid]
                    adopted_descriptor = os.pidfd_open(adopted)
                    with patch.object(owner, 'reap_exited_adoptees'):
                        with self.assertRaises(ValueError):
                            owner.barrier(runner.pid, descriptor, birth)
                    with patch.object(owner.signal, 'pidfd_send_signal') as send:
                        if mode == 'exited':
                            owner.barrier(runner.pid, descriptor, birth)
                            self.assertEqual(kernel.own_children(), [runner.pid])
                        else:
                            with self.assertRaises(ValueError):
                                owner.barrier(runner.pid, descriptor, birth)
                            self.assertIn(adopted, kernel.own_children())
                        send.assert_not_called()
                finally:
                    runner.stdin.close()
                    self.assertEqual(runner.wait(timeout=3), 0)
                    runner.stdout.close()
                    os.close(descriptor)
                    if adopted_descriptor is not None:
                        try:
                            if adopted in kernel.own_children():
                                self.assertTrue(select.select([adopted_descriptor], [], [], 3)[0])
                                os.waitid(os.P_PIDFD, adopted_descriptor, os.WEXITED | os.WNOHANG)
                        finally:
                            os.close(adopted_descriptor)
                self.assertEqual(kernel.own_children(), [])
        finally:
            kernel.subreaper(previous)

    def test_only_sealed_current_child_result_is_published(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            out = root / 'system-worker-comparison-evidence'
            out.mkdir(mode=0o700)
            pending = out / 'pending.json'
            sha = '1' * 40
            summary = {'kind': 'HOSTED_WORKER_COMPARISON_V1', 'releaseEligible': False, 'complete': True,
                       'identity': {'candidateSha': sha, 'controllerSha': sha, 'runId': 17, 'runAttempt': 1}}
            pending.write_text(json.dumps(summary))
            pending.chmod(0o600)
            with patch.dict(os.environ, {'RUNNER_TEMP': str(root), 'AIHR_CI_HEAD': sha, 'GITHUB_RUN_ID': '17'}):
                with self.assertRaises(ValueError):
                    owner.publish(owner.clock(), 1, 3)
                self.assertFalse((out / 'summary.json').exists())
                owner.publish(owner.clock(), 0, 4)
                final = json.loads((out / 'summary.json').read_text())
                self.assertEqual(final['processOwner'], {'settled': True, 'cellBarriers': 3, 'runnerExitCode': 0})
                self.assertEqual((out / 'summary.json').stat().st_mode & 0o777, 0o600)
                with self.assertRaises(FileExistsError):
                    owner.publish(owner.clock(), 0, 4)
                self.assertEqual(json.loads((out / 'summary.json').read_text()), final)


class ParallelCellTests(FamilyTests):
    """The parallel cell owner reuses every serial control, with exactly one cell barrier."""
    course = 'parallel-smoke'

    def test_exact_order_and_real_channel(self):
        parent, client = socket.socketpair()
        descriptor, finished = os.pipe()
        responses = []

        def child():
            for frame in (b'H\n', b'B1\n'):
                client.sendall(frame)
                responses.append(client.recv(8))
            # A second cell barrier must be refused; this runner owns exactly one cell.
            client.sendall(b'B2\n')

        with parent, client:
            client.settimeout(2)
            thread = threading.Thread(target=child)
            thread.start()
            try:
                with patch.object(owner, 'barrier') as barrier:
                    with self.assertRaises(ValueError):
                        owner.exchange(parent, descriptor, 71, 951, owner.clock())
                    self.assertEqual(barrier.call_count, 2)
            finally:
                thread.join(3)
                os.close(descriptor)
                os.close(finished)
        self.assertEqual(responses, [b'A0\n', b'A1\n'])

    def test_every_parallel_course_names_the_cell_job_and_entry(self):
        for course in ('parallel-2-4-8', 'parallel-smoke'):
            with patch.dict(os.environ, {'AIHR_MEASURED_BROWSER_COURSE': course}):
                self.assertEqual((owner.mode()['job'], owner.mode()['entry'], owner.mode()['cells']),
                                 ('worker-cell', '--parallel-cell', 1))
        with patch.dict(os.environ, {'AIHR_MEASURED_BROWSER_COURSE': 'preflight-2'}):
            with self.assertRaises(ValueError):
                owner.mode()

    def test_only_sealed_current_child_result_is_published(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            out = root / 'system-worker-comparison-evidence'
            out.mkdir(mode=0o700)
            pending = out / 'pending.json'
            sha = '1' * 40
            summary = {'kind': 'HOSTED_WORKER_COMPARISON_V1', 'releaseEligible': False, 'complete': True,
                       'identity': {'candidateSha': sha, 'controllerSha': sha, 'runId': 17, 'runAttempt': 1}}
            pending.write_text(json.dumps(summary))
            pending.chmod(0o600)
            with patch.dict(os.environ, {'RUNNER_TEMP': str(root), 'AIHR_CI_HEAD': sha, 'GITHUB_RUN_ID': '17'}):
                # A serial summary kind is refused by the parallel cell owner.
                with self.assertRaises(ValueError):
                    owner.publish(owner.clock(), 0, 2)
                pending.write_text(json.dumps({**summary, 'kind': 'HOSTED_WORKER_COMPARISON_CELL_V1'}))
                with self.assertRaises(ValueError):
                    owner.publish(owner.clock(), 0, 3)
                owner.publish(owner.clock(), 0, 2)
                final = json.loads((out / 'summary.json').read_text())
                self.assertEqual(final['processOwner'], {'settled': True, 'cellBarriers': 1, 'runnerExitCode': 0})


class FamilyExitWaitTests(unittest.TestCase):
    def test_waits_for_exiting_adoptees_then_reaps_them_as_zombies(self):
        states = iter(['S', 'S', 'Z', 'Z'])
        with patch.object(owner.KERNEL, 'own_children', return_value=[71, 997]), \
                patch.object(owner.KERNEL, 'identity', side_effect=lambda pid: {'state': next(states, 'Z')}), \
                patch.object(owner, 'children_of', return_value=[]), patch.object(owner.time, 'sleep'):
            self.assertTrue(owner.await_family_exit(71, owner.clock() + 5000))

    def test_bounded_wait_keeps_a_live_family_refused(self):
        with patch.object(owner.KERNEL, 'own_children', return_value=[71, 997]), \
                patch.object(owner.KERNEL, 'identity', return_value={'state': 'S'}), \
                patch.object(owner, 'children_of', return_value=[]):
            self.assertFalse(owner.await_family_exit(71, owner.clock() + 60))
        with patch.object(owner, 'exact_child'), patch.object(owner, 'await_family_exit', return_value=False) as wait, \
                patch.object(owner.KERNEL, 'own_children', return_value=[71, 997]), \
                patch.object(owner, 'children_of', return_value=[]), \
                patch.object(owner, 'reap_exited_adoptees', side_effect=ValueError('live adoptee')):
            with self.assertRaises(ValueError):
                owner.barrier(71, 9, 951, deadline=owner.clock() + 60)
            wait.assert_called_once()

    def test_wait_is_bounded_by_the_frontier_and_fixed_ceiling(self):
        with patch.object(owner.KERNEL, 'own_children', return_value=[71, 997]), \
                patch.object(owner.KERNEL, 'identity', return_value={'state': 'R'}), \
                patch.object(owner, 'children_of', return_value=[]):
            started = owner.clock()
            self.assertFalse(owner.await_family_exit(71, started))
            self.assertLess(owner.clock() - started, 1000)
        self.assertEqual(owner.FAMILY_EXIT_WAIT_MS, 20_000)


if __name__ == '__main__':
    unittest.main()
