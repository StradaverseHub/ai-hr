"""Late staging recovery sequencing and refusal cases with explicit privileged ports."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('late', ROOT / 'deploy/systemd/bank_import_worker_late_v1.py')
late = importlib.util.module_from_spec(spec)
spec.loader.exec_module(late)


def require(ok, message):
    if not ok:
        raise ValueError(message)


class LateWorkerRecovery(unittest.TestCase):
    def setUp(self):
        self.base = SimpleNamespace(check=require)
        self.ci = SimpleNamespace(epoch=float, SLOT_DEADLINE=time.monotonic() + 590, sha=lambda _: 'hash')
        self.authority = {
            'identity': dict(late.CASE, unit_sha256='a'*64, worker_env_sha256='b'*64),
            'lease': {'candidate': late.CASE['source'], 'batch': '8a8394a6-bca2-46f9-a082-e9b2157406b6', 'epoch': 137},
            'install': {'id': 'b8b1e385-1244-4709-a17c-ba9ce9544ad4',
                        'buildRecordId': '424938b1-ffa2-4645-9b41-3eb670e77891', 'runId': 44750610971},
            'lateFailure': {**dict.fromkeys(late.FAILURE_FIELDS, 'digest'), 'failureFinishedAt': '1795188886', 'failureCurrentSha256': late.CURRENT_SHA256,
                            'failureLastOkSha256': late.LAST_OK_SHA256},
            'sourceManifestSha256': late.SOURCE_MANIFEST_SHA256,
            'launch': {'current': dict.fromkeys(['ref', 'pid', 'log', 'started_at', 'phase', 'build_id', 'built_at'])},
            'priorLastOkSha256': late.LAST_OK_SHA256,
            'issuedAt': time.time()-1, 'expiresAt': time.time()+580,
            'preparedWorker': {'path': 'proof', 'sha256': 'prepared'},
        }

    def test_only_exact_case_and_fresh_stage_can_enter(self):
        a = self.authority
        late.authority(self.base, self.ci, late.DRAIN, a)
        for key in late.CASE:
            with self.subTest(key=key), patch.dict(a['identity'], {key: 'other'}):
                with self.assertRaisesRegex(ValueError, 'exact approved staging worker case'):
                    late.authority(self.base, self.ci, late.DRAIN, a)
        with patch.dict(a['lease'], epoch=138):
            with self.assertRaisesRegex(ValueError, 'exact interrupted staging lease'):
                late.authority(self.base, self.ci, late.DRAIN, a)
        with patch.dict(a, expiresAt=time.time()-5):
            with self.assertRaisesRegex(ValueError, 'finite'):
                late.authority(self.base, self.ci, late.DRAIN, a)

    def test_failed_web_proof_or_changed_prepared_bytes_never_drains(self):
        guard = SimpleNamespace(a=self.authority, bytes=b'review')
        update = Mock()
        for first_fails in (True, False):
            with patch.object(late, 'require_native_failure') as known, patch.object(late, 'load_preparation') as prep:
                (known if first_fails else prep).side_effect = ValueError('untrusted state')
                with self.assertRaisesRegex(ValueError, 'untrusted state'):
                    late.drain(guard, self.base, self.ci, Mock(), update, Path('/unused'))
        update.drain.assert_not_called()
        update.publish.assert_not_called()

    def test_drain_signals_after_exact_proofs_and_records_actual_result(self):
        events = []
        guard = SimpleNamespace(a=self.authority, bytes=b'review')
        update = SimpleNamespace(validate_existing=lambda *args: {'MainPID': '71'},
                                 publish=lambda _, path, raw, mode: events.append((path.name, json.loads(raw), mode)),
                                 drain=lambda *args: (events.append('drain') or {'state': 'drained', 'pid': 71, 'forcedKill': False}))
        fmt = SimpleNamespace(canonical=lambda data: json.dumps(data).encode())
        with tempfile.TemporaryDirectory() as temporary, contextlib.redirect_stdout(io.StringIO()):
            with patch.object(late, 'require_native_failure', side_effect=lambda *a, **kw: events.append('web-proof')), \
                 patch.object(late, 'load_preparation', side_effect=lambda *a: events.append('package-proof')), \
                 patch.object(late, 'snapshot', side_effect=lambda *a: events.append('terminal')):
                late.drain(guard, self.base, self.ci, fmt, update, Path(temporary))
        self.assertEqual(events[:2], ['web-proof', 'package-proof'])
        self.assertEqual([events[2][0], *events[3:6]], ['late-drain-started.json', 'terminal', 'drain', 'terminal'])
        leaf, receipt, mode = events[-1]
        self.assertEqual((leaf, mode, receipt['kind']), ('drained.json', 0o400, 'ACTUAL_POST_FAILURE_WORKER_DRAIN'))
        self.assertEqual(receipt['drain'], {'state': 'drained', 'pid': 71, 'forcedKill': False})

    def test_activation_requires_native_and_complete_proofs_before_unit_changes(self):
        observer = SimpleNamespace(base=self.base, guard=SimpleNamespace(ci=self.ci), auth=self.authority,
                                   overall_deadline=time.monotonic()+620, fence_count=3, audits=[1],
                                   content_proofs=[1])
        with patch.object(late, 'failed_snapshot') as terminal:
            late.admit_mutation(observer)
            terminal.assert_called_once_with(observer)
            observer.fence_count = 2
            with self.assertRaisesRegex(ValueError, 'proof graph'):
                late.admit_mutation(observer)
            observer.fence_count = 3
            observer.overall_deadline = time.monotonic()+500
            with self.assertRaisesRegex(ValueError, 'insufficient'):
                late.admit_mutation(observer)

    def test_activation_rejects_substitute_drain_receipts(self):
        ci = self.ci
        ci.ACTIVATION_FIELDS = set()
        a = {**self.authority, 'nativeActivation': {}, 'firstStageApprovalSha256': 'drain-approval'}
        first = {key:a[key] for key in (late.fields(ci, late.DRAIN)-{'kind','gate','issuedAt','expiresAt'})}
        receipt = {'kind':'ACTUAL_POST_FAILURE_WORKER_DRAIN','lateFailure':a['lateFailure'],
                   'drain':{'state':'drained','forcedKill':False},'preparedWorker':a['preparedWorker'],
                   'approvalSha256':a['firstStageApprovalSha256']}
        self.base.read_bounded = lambda *_: json.dumps(receipt).encode()
        observer = SimpleNamespace(base=self.base, guard=SimpleNamespace(ci=ci), auth=a, operation=Path('/unused'))
        with patch.object(late, 'failed_snapshot') as terminal:
            late.check_history(observer, first)
            terminal.assert_called_once_with(observer)
            receipt['kind'] = 'ordinary-drain'
            with self.assertRaisesRegex(ValueError, 'real protected late drain'):
                late.check_history(observer, first)


if __name__ == '__main__':
    unittest.main()
