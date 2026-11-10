"""Synthetic process and publication controls. No application or Docker."""
import json
import os
from pathlib import Path
import socket
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
                         {'kind': 'WORKER_COMPARISON_FAMILY_FAILURE_V1', 'stage': 'unavailable', 'ordinal': None})
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
                                 {'kind': 'WORKER_COMPARISON_FAMILY_FAILURE_V1', 'stage': stage, 'ordinal': 0})
            finally:
                os.close(descriptor)
                os.close(finished)

    def test_refuses_unknown_child_or_adopted_process(self):
        with patch.object(owner, 'exact_child') as exact:
            for direct, adopted in (([16], [71]), ([], [71, 16])):
                with patch.object(owner, 'children_of', return_value=direct), patch.object(owner.KERNEL, 'own_children', return_value=adopted):
                    with self.assertRaises(ValueError):
                        owner.barrier(71, 9, 951)
            with patch.object(owner, 'children_of', return_value=[]), patch.object(owner.KERNEL, 'own_children', return_value=[71]):
                owner.barrier(71, 9, 951)
            self.assertEqual(exact.call_count, 4)

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


if __name__ == '__main__':
    unittest.main()
