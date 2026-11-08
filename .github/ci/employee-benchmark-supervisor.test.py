"""Native Linux process controls only. No application/DB/performance execution."""
import importlib.util
import os
import json
import time
import tempfile
from unittest.mock import patch
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
        self.assertEqual(module.job_budget('native-controls', anchor, env, 'fixed-host', 1800), (180, 800))
        with self.assertRaises(ValueError):
            module.job_budget('native-controls', anchor, env, 'fixed-host', 1865)

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

    def test_slow_failed_optional_terminal_caps_still_reserve_actual_stop_and_artifact_tail(self):
        env = {'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1', 'AIHR_FOCUSED_JOB_MONOTONIC_NS': '1000000000000'}
        anchor = {'version': 1, 'run': '123', 'attempt': '1', 'job': 'selected-tests', 'bootId': 'fixed-host', 'startNs': env['AIHR_FOCUSED_JOB_MONOTONIC_NS'], 'wallTimeNs': '1800000000000000000'}
        now = 2044
        for stage in ['git-head', 'git-status', 'evidence', 'stats']:
            seconds, _ = module.job_budget(stage, anchor, env, 'fixed-host', now)
            now += seconds + 6  # Even a failed command consumes its full shutdown proof.
        for stage in ['logs', 'inspect']:
            with self.assertRaises(ValueError):
                module.job_budget(stage, anchor, env, 'fixed-host', now)
        seconds, elapsed = module.job_budget('stop', anchor, env, 'fixed-host', now)
        self.assertEqual(seconds, 9)
        self.assertLessEqual(elapsed + seconds + 6 + 30, 1170)

class ClosedEntryModels(unittest.TestCase):
    def test_actual_closed_main_runs_mandatory_stop_despite_initial_and_all_later_progress_failures(self):
        # Actual main/request/clock/stage/fork/reap code executes. ONLY the child
        # process edge is substituted for a stdlib marker: no Docker/PG call or
        # actual hosted DB admission is claimed by this explicitly modelled env.
        with tempfile.TemporaryDirectory(prefix='aihr-closed-stop-') as folder:
            temporary = Path(folder).resolve(); destination = temporary / 'evidence'; destination.mkdir()
            marker = temporary / 'stopped'
            control = Path(__file__).resolve().parents[2]
            run = '123'; start = str(time.monotonic_ns())
            anchor = {'version': 1, 'run': run, 'attempt': '1', 'job': 'selected-tests', 'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip(), 'startNs': start, 'wallTimeNs': str(time.time_ns())}
            env = {'RUNNER_TEMP': str(temporary), 'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted', 'GITHUB_RUN_ID': run, 'GITHUB_RUN_ATTEMPT': '1', 'AIHR_FOCUSED_TESTS': json.dumps([module.FILE]), 'AIHR_CI_HEAD': 'a'*40, 'AIHR_CI_CONTROL_HEAD': 'b'*40, 'AIHR_FOCUSED_JOB_MONOTONIC_NS': start, 'AIHR_FOCUSED_JOB_ANCHOR': json.dumps(anchor)}
            request = {'stage': 'stop', 'node': os.environ['AIHR_BENCHMARK_TEST_NODE'], 'controller': str(control), 'destination': str(destination)}
            original_exec = os.execvpe
            def child_edge(executable, argv, values):
                if argv != ['bash', str(control / '.github/ci/postgres.sh'), 'stop']:
                    os._exit(95)
                original_exec(sys.executable, [sys.executable, '-I', '-B', '-c', 'from pathlib import Path;Path('+repr(str(marker))+').write_text("STOPPED")'], values)
            with patch.dict(os.environ, env), patch.object(sys, 'argv', [__file__, json.dumps(request)]), patch.object(module, 'append_event', side_effect=OSError('PRIVATE_PAYLOAD')), patch.object(module.os, 'execvpe', side_effect=child_edge):
                self.assertEqual(module.main(), 1)
            self.assertEqual(marker.read_text(), 'STOPPED')
            self.assertEqual(module.own_children(), [])
            with patch.dict(os.environ, {**env, 'AIHR_FOCUSED_TESTS': json.dumps([module.CONTROL_FILE])}):
                stage, command, _ = module.request_command({**request, 'stage': 'native-controls'})
                self.assertEqual(stage, 'native-controls')
                self.assertEqual(command[4], module.CONTROL_FILE)
                with self.assertRaises(ValueError):
                    module.request_command({**request, 'stage': 'benchmark'})
            with patch.dict(os.environ, env), self.assertRaises(ValueError):
                module.request_command({**request, 'stage': 'native-controls'})

if __name__ == '__main__':
    unittest.main()
