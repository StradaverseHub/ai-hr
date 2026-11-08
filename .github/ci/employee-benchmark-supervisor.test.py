"""Native Linux process controls only. No application/DB/performance execution."""
import importlib.util
import os
from pathlib import Path
import sys
import unittest

spec = importlib.util.spec_from_file_location('supervisor', Path(__file__).with_name('employee-benchmark-supervisor.py'))
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)

class NativeSupervisor(unittest.TestCase):
    def run_owned(self, argv, seconds=1, **options):
        events = []
        result = module.supervise(argv, seconds, events.append, **options)
        self.assertTrue(result['groupQuiescent'])
        self.assertTrue(result['reaped'])
        kinds = [row['kind'] for row in events]
        self.assertLess(kinds.index('session-admitted'), kinds.index('group-stop-before-reap'))
        self.assertLess(kinds.index('group-stop-before-reap'), kinds.index('group-quiescent-then-reaped'))
        return result, events

    def test_normal_fixed_command_and_final_anchor_reaping(self):
        result, _ = self.run_owned([sys.executable, '-I', '-B', '-c', 'pass'])
        self.assertEqual((result['reason'], result['commandExit']), ('complete', 0))

    def test_actual_blocked_javascript_cannot_starve_external_clock(self):
        node = os.environ['AIHR_BENCHMARK_TEST_NODE']
        result, _ = self.run_owned([node, '-e', 'while(true){}'], .25)
        self.assertEqual(result['reason'], 'deadline')

    def test_live_descendant_dies_before_reserved_monitor_is_reaped(self):
        # Monitor dies AFTER admitting a real child. WNOWAIT keeps the monitor's
        # native PID reserved until its existing session group is terminated.
        result, _ = self.run_owned([sys.executable, '-I', '-B', '-c', 'import time;time.sleep(30)'], 1, monitor_fault='after-command')
        self.assertEqual(result['reason'], 'monitor-died')

    def test_hung_subprocess_and_leftover_child_cannot_be_reported_complete(self):
        result, _ = self.run_owned([sys.executable, '-I', '-B', '-c', 'import os,time\np=os.fork()\nif p==0: time.sleep(30)\nelse: time.sleep(30)'], .25)
        self.assertEqual(result['reason'], 'deadline')

    def test_detached_session_is_refused_even_after_owned_pidfd_cleanup(self):
        result, _ = self.run_owned([sys.executable, '-I', '-B', '-c', 'import os,time\np=os.fork()\nif p==0: os.setsid();time.sleep(30)\nelse: time.sleep(.1)'])
        self.assertEqual(result['reason'], 'session-escaped')
        self.assertTrue(result['escapedSession'])

    def test_nonzero_command_exit_remains_failure(self):
        result, _ = self.run_owned([sys.executable, '-I', '-B', '-c', 'raise SystemExit(7)'])
        self.assertEqual((result['reason'], result['commandExit']), ('command-failed', 7))

    def test_progress_failure_still_terminates_and_reaps_before_refusal(self):
        def broken(_event):
            raise OSError('Private diagnostic payload must never be reflected')
        result = module.supervise([sys.executable, '-I', '-B', '-c', 'pass'], 1, broken)
        self.assertEqual(result['reason'], 'protocol-refused')
        self.assertTrue(result['reaped'])
        self.assertTrue(result['groupQuiescent'])
        self.assertNotIn('Private', str(result))

    def test_invalid_limit_refuses_before_command(self):
        for seconds in (0, -1, 961, True):
            with self.assertRaises(ValueError):
                module.supervise([sys.executable, '-c', 'pass'], seconds, lambda _: None)

class BudgetModels(unittest.TestCase):
    def test_closed_anchor_and_full900_budget_admission(self):
        env = {'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1', 'AIHR_FOCUSED_JOB_MONOTONIC_NS': '1000000000000'}
        anchor = {'version': 1, 'run': '123', 'attempt': '1', 'job': 'selected-tests', 'bootId': 'fixed-host', 'startNs': env['AIHR_FOCUSED_JOB_MONOTONIC_NS'], 'wallTimeNs': '1800000000000000000'}
        self.assertEqual(module.job_budget('benchmark', anchor, env, 'fixed-host', 1010), (960, 10))
        for change in ({'version': True}, {'startNs': 'future'}, {'bootId': 'foreign'}, {'job': 'other'}, {'run': '124'}, {'wallTimeNs': None}, {'unknown': 1}):
            with self.assertRaises(ValueError):
                module.job_budget('benchmark', {**anchor, **change}, env, 'fixed-host', 1010)
        for now in (999, 1145, 2170):
            with self.assertRaises(ValueError):
                module.job_budget('benchmark', anchor, env, 'fixed-host', now)
        self.assertEqual(module.job_budget('stop', anchor, env, 'fixed-host', 2110), (9, 1110))

    def test_file_clock_never_acknowledges_an_incomplete900_second_envelope(self):
        env = {'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1'}
        witness = {'version': 1, 'run': '123', 'attempt': '1', 'startNs': '1010000000000'}
        self.assertEqual(module.check_file_clock(witness, env, 1000, 1011, 960), 1010)
        for seconds in (900, 909):
            with self.assertRaises(ValueError):
                module.check_file_clock(witness, env, 1000, 1011, seconds)
        for change in ({'version': True}, {'run': '124'}, {'startNs': '999000000000'}, {'startNs': '1012000000000'}, {'extra': 1}):
            with self.assertRaises(ValueError):
                module.check_file_clock({**witness, **change}, env, 1000, 1011, 960)

if __name__ == '__main__':
    unittest.main()
