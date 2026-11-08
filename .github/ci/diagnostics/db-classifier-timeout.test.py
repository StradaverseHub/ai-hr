"""Ordinary source/protocol controls. No native admission or classifier execution."""
import hashlib
import json
import os
import signal
import types
import tempfile
import unittest
from pathlib import Path
from types import ModuleType
from unittest.mock import patch

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


    def state(self):
        return {'start': None, 'settling': False, 'transportFailures': [], 'ownerLost': False}

    def kernel_handler(self, globals_=None):
        code = next(code for code in M.K.supervise.__code__.co_consts
                    if isinstance(code, types.CodeType) and code.co_name == 'interrupt')
        self.assertEqual(code.co_freevars, ('stopped',))
        cell = (lambda value: lambda: value)(False).__closure__[0]
        return types.FunctionType(code, M.K.__dict__ if globals_ is None else globals_, 'interrupt', closure=(cell,)), cell

    def test_prehandler_no_ack_pidfd_failure_clock_never_self_terms_and_retains_owner_loss(self):
        # The real qualified kernel has this exact clock-before-handler failure
        # branch; model the callback seam without launching or signalling a process.
        source = M.kernel_path.read_text()
        start = source.index('    try:\n        descriptor = os.pidfd_open(child)')
        finish = source.index('    started = clock(); deadline = started + seconds', start)
        self.assertIn('until = clock() + 3', source[start:finish])
        self.assertLess(finish, source.index('    for sig in (signal.SIGTERM, signal.SIGINT):', finish))
        state, errors, work = self.state(), [], []
        clock = M.phase_clock(state, parent_fd=lambda: 99, drain=lambda: work.append('drain'),
            sampler=types.SimpleNamespace(sample=lambda _elapsed: work.append('sample')), phase='baseline', errors=lambda: errors)
        with patch.object(M.time, 'monotonic', side_effect=[100.0, 100.1, 100.2]), \
                patch.object(M.select, 'select', return_value=([99], [], [])), \
                patch.object(M.signal, 'getsignal', return_value=signal.SIG_DFL), patch.object(M.os, 'kill') as kill:
            self.assertEqual(clock(), 100.0)
            self.assertEqual(clock(), 100.2)
            kill.assert_not_called()
        self.assertTrue(state['ownerLost'])
        self.assertEqual(state['transportFailures'], ['upstream-owner-lost-without-qualified-handler'])
        self.assertEqual(work, ['drain', 'sample']); self.assertEqual(errors, [])

    def test_owner_loss_between_poll_and_session_admission_refuses_before_native_workload_ack(self):
        state = self.state()
        with patch.object(M.select, 'select', return_value=([99], [], [])), patch.object(M.os, 'kill') as kill:
            with self.assertRaises(ValueError):
                M.require_upstream_before_ack(99, state)
            kill.assert_not_called()
        self.assertTrue(state['ownerLost'])
        self.assertEqual(state['transportFailures'], ['upstream-owner-lost-before-workload-ack'])
        current = self.state()
        with patch.object(M.select, 'select', return_value=([], [], [])):
            M.require_upstream_before_ack(99, current)
        self.assertFalse(current['ownerLost']); self.assertEqual(current['transportFailures'], [])
        # Bind the actual source call order to the reviewed kernel's guarded
        # emit/ACK boundary; this is not a fabricated native admission receipt.
        source = SOURCE.read_text(); begin = source.index('    def event(packet):', source.index('def _run_phase('))
        gate = source.index('require_upstream_before_ack(parent_fd, state)', begin)
        self.assertLess(gate, source.index("atomic_json(out / (phase + '-clock.json')", begin))
        self.assertNotIn('mandatory=True', source[source.index('def _run_phase('):])

    def test_exact_active_kernel_handler_interrupts_only_self_once_and_keeps_actual_clock(self):
        handler, stopped = self.kernel_handler(); self.assertTrue(M.qualified_kernel_interrupt(handler))
        state, errors, work = self.state(), [], []; state['start'] = 100.0
        clock = M.phase_clock(state, parent_fd=lambda: 99, drain=lambda: work.append('drain'),
            sampler=types.SimpleNamespace(sample=lambda _elapsed: work.append('sample')), phase='profile', errors=lambda: errors)
        with patch.object(M.time, 'monotonic', side_effect=[100.1, 100.2, 100.3, 100.4]), \
                patch.object(M.select, 'select', return_value=([99], [], [])), \
                patch.object(M.signal, 'getsignal', return_value=handler), patch.object(M.os, 'getpid', return_value=456), \
                patch.object(M.os, 'kill', side_effect=lambda _pid, sig: handler(sig, None)) as kill:
            self.assertEqual(clock(), 100.2); self.assertEqual(clock(), 100.4)
            kill.assert_called_once_with(456, signal.SIGTERM)
        self.assertIs(stopped.cell_contents, True); self.assertTrue(state['ownerLost'])
        self.assertEqual(work, ['drain', 'sample', 'drain', 'sample']); self.assertEqual(errors, [])
        self.assertEqual(state['transportFailures'], [])

    def test_foreign_globals_or_spoofed_filename_never_authorize_self_signal_during_cleanup(self):
        foreign, _ = self.kernel_handler({})
        spoof = (lambda _signal, _frame: None)
        spoof = types.FunctionType(spoof.__code__.replace(co_filename=str(M.kernel_path), co_name='interrupt'), M.K.__dict__)
        for handler in (foreign, spoof):
            self.assertFalse(M.qualified_kernel_interrupt(handler))
            state, errors, work = self.state(), [], []; state['start'] = 100.0; state['settling'] = True
            clock = M.phase_clock(state, parent_fd=lambda: 99, drain=lambda: work.append('drain'),
                sampler=types.SimpleNamespace(sample=lambda _elapsed: self.fail('No sampler during cleanup')),
                phase='profile', errors=lambda: errors)
            with patch.object(M.time, 'monotonic', return_value=101.0), \
                    patch.object(M.select, 'select', return_value=([99], [], [])), \
                    patch.object(M.signal, 'getsignal', return_value=handler), patch.object(M.os, 'kill') as kill:
                self.assertEqual(clock(), 101.0); kill.assert_not_called()
            self.assertTrue(state['ownerLost']); self.assertEqual(work, ['drain']); self.assertEqual(errors, [])
            self.assertEqual(state['transportFailures'], ['upstream-owner-lost-without-qualified-handler'])

    def test_distinct_drain_errors_of_same_class_survive_without_throwing_through_kernel_clock(self):
        first, second = OSError('fictional-first'), OSError('fictional-second')
        state, errors = self.state(), []; state['start'] = 100.0; state['settling'] = True
        drain = unittest.mock.Mock(side_effect=[first, second])
        clock = M.phase_clock(state, parent_fd=lambda: None, drain=drain,
            sampler=types.SimpleNamespace(sample=lambda _elapsed: self.fail('No sampler during cleanup')),
            phase='baseline', errors=lambda: errors)
        with patch.object(M.time, 'monotonic', side_effect=[101.0, 102.0]):
            self.assertEqual(clock(), 101.0); self.assertEqual(clock(), 102.0)
        self.assertEqual(drain.call_count, 2); self.assertEqual(errors, [first, second])
        self.assertIs(errors[0], first); self.assertIs(errors[1], second)
        self.assertEqual(state['transportFailures'], ['OSError'])


if __name__ == '__main__': unittest.main()
