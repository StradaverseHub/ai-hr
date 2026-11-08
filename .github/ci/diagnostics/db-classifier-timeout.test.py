"""Ordinary source/protocol controls. No native admission or classifier execution."""
import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import ModuleType

SOURCE = Path(__file__).with_name('db-classifier-timeout.py').resolve()
M = ModuleType('classifier_timeout_source_control'); M.__file__ = str(SOURCE)
exec(compile(SOURCE.read_bytes(), str(SOURCE), 'exec', dont_inherit=True), M.__dict__)


class DiagnosticControls(unittest.TestCase):
    def test_ordinary_process_cannot_admit_or_launch_a_closed_phase(self):
        with self.assertRaises(ValueError): M.admit()
        for phase in ('baseline', 'profile', 'inventory', 'arbitrary'):
            with self.assertRaises(ValueError): M._run_phase(phase, {}, {})

    def test_proc_stat_parser_handles_parentheses_and_keeps_exact_start_cpu_rss(self):
        fields = ['R', '11', '12', '12'] + ['0'] * 7 + ['31', '7'] + ['0'] * 6 + ['12345', '0', '9']
        row = M.stat_row(b'99 (a ) b) ' + ' '.join(fields).encode(), 99)
        self.assertEqual(M.identity_fields(row), {'pid': 99, 'parent': 11, 'group': 12, 'session': 12, 'start': 12345})
        self.assertEqual((row['userTicks'], row['systemTicks'], row['rssPages']), (31, 7, 9))

    def test_wrong_pid_truncated_or_negative_proc_facts_refuse(self):
        for raw in (b'98 (x) R 1', b'99 x R 1', b'99 (x) R 1', b'99 (x) R -1 ' + b'0 ' * 30):
            with self.assertRaises((ValueError, IndexError)): M.stat_row(raw, 99)

    def test_io_parser_requires_all_exact_native_counters_and_never_invents_missing_zero(self):
        names = ('rchar', 'wchar', 'syscr', 'syscw', 'read_bytes', 'write_bytes', 'cancelled_write_bytes')
        raw = ''.join('%s: %s\n' % (name, i) for i, name in enumerate(names)).encode()
        self.assertEqual(M.io_row(raw), dict(zip(names, range(7))))
        for changed in (raw.replace(b'rchar: 0\n', b''), raw + b'rchar: 0\n', raw.replace(b'rchar: 0', b'rchar: -1'), b''):
            with self.assertRaises(ValueError): M.io_row(changed)

    def test_no_sample_is_unavailable_and_no_pid_or_proc_payload_is_exposed(self):
        sampler = M.NativeSampler(Path('/owned/node')); value = sampler.summary()
        self.assertFalse(value['available']); self.assertIsNone(value['peakSampledRssBytes']); self.assertIsNone(value['first']); self.assertIsNone(value['last'])
        self.assertEqual(value['unavailable'], ['no-admitted-native-sample']); self.assertFalse(value['wholeProcessCostProved'])
        text = json.dumps(value); self.assertNotIn('/owned', text); self.assertNotIn('pid', text)

    def test_a_lost_identity_keeps_available_prior_counters_and_marks_uncertainty(self):
        sampler = M.NativeSampler(Path('/owned/node')); sampler.samples = 1; sampler.peak = 4096
        sampler.initial = sampler.last = {'elapsedSeconds': .1, 'userTicks': 2, 'systemTicks': 1, 'rssBytes': 4096, 'io': {'rchar': 10}}
        sampler.unavailable('identity-lost'); sampler.unavailable('identity-lost'); value = sampler.summary()
        self.assertTrue(value['available']); self.assertEqual(value['unavailable'], ['identity-lost']); self.assertEqual(value['last']['userTicks'], 2)

    def test_descriptor_reader_refuses_aliases_bounds_and_source_changes_without_editing_them(self):
        with tempfile.TemporaryDirectory(prefix='classifier-byte-model-') as temporary:
            root = Path(temporary); path = root / 'owned'; path.write_bytes(b'fixed'); path.chmod(0o600)
            self.assertEqual(M.bounded(path, 5), b'fixed')
            with self.assertRaises(ValueError): M.bounded(path, 4)
            alias = root / 'alias'; alias.symlink_to(path)
            with self.assertRaises(OSError): M.bounded(alias, 5)
            alias.unlink(); os.link(path, alias)
            with self.assertRaises(ValueError): M.bounded(path, 5)
            self.assertEqual(path.read_bytes(), b'fixed')

    def test_current_source_is_whole_bound_and_original_classifier_plan_and_kernel_remain_exact(self):
        manifest = json.loads((M.ROOT / M.MANIFEST).read_text())
        for name, wanted in manifest['componentSources'].items():
            self.assertEqual(hashlib.sha256((M.ROOT / name).read_bytes()).hexdigest(), wanted, name)
        self.assertEqual(hashlib.sha256((M.ROOT / 'scripts/gate-db-classify.ts').read_bytes()).hexdigest(), M.CLASSIFIER_SHA)
        self.assertEqual(hashlib.sha256((M.ROOT / '.github/ci/owned-process.py').read_bytes()).hexdigest(), M.KERNEL_SHA)
        self.assertIn('timeout:15000,killSignal:\'SIGTERM\'', (M.ROOT / '.github/ci/plan.mjs').read_text())
        self.assertEqual(manifest['suite'], sorted(set(manifest['suite']))); self.assertIn(M.SELECTOR, manifest['suite'])


if __name__ == '__main__': unittest.main()
