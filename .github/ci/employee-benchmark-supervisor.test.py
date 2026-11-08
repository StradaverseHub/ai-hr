"""Native Linux process controls only. No application/DB/performance execution."""
import importlib.util
import os
import json
import ast
import hashlib
import marshal
import struct
from types import ModuleType
import time
import tempfile
from unittest.mock import patch
from pathlib import Path
import sys
import unittest

adapter_source = Path(__file__).resolve().with_name('employee-benchmark-supervisor.py')
module = ModuleType('supervisor'); module.__file__ = str(adapter_source)
exec(compile(adapter_source.read_bytes(), str(adapter_source), 'exec', dont_inherit=True), module.__dict__)

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
        self.assertEqual(module.LIMITS['native-controls'], 180)
        self.assertEqual(module.LIMITS['native-factory'], 128 + 3 * 26)
        self.assertEqual(module.job_budget('native-factory', anchor, env, 'fixed-host', 1800), (206, 800))
        with self.assertRaises(ValueError):
            module.job_budget('native-factory', anchor, env, 'fixed-host', 1839)

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

class AsciiAdmissionModels(unittest.TestCase):
    def test_distinct_ascii_full_file_clocks_refuse_partial_future_and_cross_run_envelopes(self):
        env = {'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1', 'AIHR_FOCUSED_JOB_MONOTONIC_NS': '1000000000000'}
        anchor = {'version': 1, 'run': '123', 'attempt': '1', 'job': 'selected-tests', 'bootId': 'fixed-host', 'startNs': env['AIHR_FOCUSED_JOB_MONOTONIC_NS'], 'wallTimeNs': '1800000000000000000'}
        self.assertEqual(module.FILE_CLOCK_DIRECTORIES, {'benchmark': 'employee-choice-native-purpose', 'ascii-purpose': 'employee-choice-exact-ascii-purpose', 'ascii-plan': 'employee-choice-exact-ascii'})
        witness = {'version': 1, 'run': '123', 'attempt': '1', 'startNs': '1060000000000'}
        for stage in ('ascii-purpose', 'ascii-plan'):
            seconds, elapsed = module.job_budget(stage, anchor, env, 'fixed-host', 1010)
            self.assertEqual((seconds, elapsed), (960, 10))
            self.assertEqual(module.check_file_clock(witness, env, 1000, 1060, seconds), 1060)
            with self.assertRaises(ValueError):
                module.job_budget(stage, anchor, env, 'fixed-host', 1145)
            with self.assertRaises(ValueError):
                module.check_file_clock(witness, env, 1000, 1060, 959)
            with self.assertRaises(ValueError):
                module.check_file_clock({**witness, 'run': '124'}, env, 1000, 1060, seconds)

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
            with patch.dict(os.environ, env), patch.object(sys, 'argv', [__file__, json.dumps(request)]), patch.object(module, 'append_event', side_effect=OSError('PRIVATE_PAYLOAD')), patch.object(module._owned_process.os, 'execvpe', side_effect=child_edge):
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
            for selected, expected_stage, fixed_file in [([module.FILE], 'benchmark', module.FILE), ([module.CONTROL_FILE], 'native-controls', module.CONTROL_FILE), ([module.FACTORY_FILE], 'native-factory', module.FACTORY_FILE), ([module.ASCII_PURPOSE_FILE], 'ascii-purpose', module.ASCII_PURPOSE_FILE), ([module.ASCII_PLAN_FILE], 'ascii-plan', module.ASCII_PLAN_FILE)]:
                with patch.dict(os.environ, {**env, 'AIHR_FOCUSED_TESTS': json.dumps(selected)}):
                    stage, command, _ = module.request_command({**request, 'stage': expected_stage})
                    self.assertEqual(stage, expected_stage)
                    prefix = [request['node'], str(Path.cwd() / 'node_modules/vitest/vitest.mjs'), 'run'] if expected_stage in ('ascii-purpose', 'ascii-plan') else ['pnpm', 'exec', 'vitest', 'run']
                    self.assertEqual(command, [*prefix, fixed_file, '--reporter=default', '--reporter=json', '--outputFile.json=' + str(destination / 'db.vitest.json')])
                    if expected_stage in ('ascii-purpose', 'ascii-plan'):
                        # No env unsetting or eligibility waiver is performed.
                        with patch.dict(os.environ, {'NODE_PATH': '/fixed-untrusted-startup-control'}):
                            self.assertEqual(module.request_command({**request, 'stage': expected_stage})[1], command)
                            self.assertEqual(os.environ['NODE_PATH'], '/fixed-untrusted-startup-control')
                    for other in {'benchmark', 'native-controls', 'native-factory', 'ascii-purpose', 'ascii-plan'} - {expected_stage}:
                        with self.assertRaises(ValueError):
                            module.request_command({**request, 'stage': other})
            for selected in [[], [module.FACTORY_FILE, module.CONTROL_FILE], [module.FACTORY_FILE, module.FACTORY_FILE], [module.FACTORY_FILE + '.extra']]:
                with patch.dict(os.environ, {**env, 'AIHR_FOCUSED_TESTS': json.dumps(selected)}), self.assertRaises(ValueError):
                    module.request_command({**request, 'stage': 'native-factory'})

class SharedKernelModels(unittest.TestCase):
    def test_complete_c73_adapter_reconstruction_and_exact_extracted_helpers(self):
        folder = Path(__file__).resolve().parent
        archive = json.loads((folder / 'owned-process-extraction.json').read_text())
        self.assertEqual(archive['base'], 'c73c8e15400890e5dfcb0d32d178929a5522ab5c')
        current = (folder / 'employee-benchmark-supervisor.py').read_text()
        registry_inverse = json.loads((folder / 'employee-lifecycle-focused-inverse.json').read_text())
        self.assertEqual(registry_inverse['base'], '7168310233f4bdf9dbe9308c1b783a8592c1ca8c')
        self.assertEqual(hashlib.sha256(current.encode()).hexdigest(), registry_inverse['currentSha256'])
        for change in reversed(registry_inverse['changes']):
            self.assertEqual(current.count(change['after']), 1)
            current = current.replace(change['after'], change['before'])
        self.assertEqual(hashlib.sha256(current.encode()).hexdigest(), registry_inverse['oldSha256'])
        extension = json.loads((folder / 'employee-ascii-adapter-inverse.json').read_text())
        self.assertEqual(extension['base'], '756e834dc0db88b5131547bc6d5108284201ab48')
        self.assertEqual(hashlib.sha256(current.encode()).hexdigest(), extension['currentAdapterSha256'])
        for change in reversed(extension['changes']):
            self.assertEqual(current.count(change['after']), 1)
            current = current.replace(change['after'], change['before'])
        self.assertEqual(hashlib.sha256(current.encode()).hexdigest(), extension['priorAdapterSha256'])
        shared = (folder / 'owned-process.py').read_text()
        span = shared[shared.index('REASONS = '):]
        self.assertEqual(hashlib.sha256(span.encode()).hexdigest(), archive['extractedSpanSha256'])
        self.assertEqual(current.count(archive['loader']), 1)
        original = current.replace(archive['loader'], span)
        self.assertEqual(hashlib.sha256(original.encode()).hexdigest(), archive['originalSha256'])

    def test_fixed_sibling_and_actual_kernel_globals_have_no_second_command_or_process_loop(self):
        kernel = module._owned_process
        self.assertEqual(Path(kernel.__file__).resolve(), Path(__file__).resolve().with_name('owned-process.py'))
        self.assertIs(module.supervise, kernel.supervise)
        self.assertIs(module.supervise.__globals__, kernel.__dict__)
        self.assertIs(module.append_event, kernel.append_event)
        tree = ast.parse(Path(kernel.__file__).read_text())
        self.assertEqual([node.name for node in tree.body if isinstance(node, ast.FunctionDef)],
                         ['require', 'identity', 'live_group', 'own_children', 'subreaper', 'settle_adopted', 'write_packet', 'append_event', 'supervise'])
        self.assertEqual([alias.name for node in tree.body if isinstance(node, ast.Import) for alias in node.names],
                         ['json', 'ctypes', 'os', 're', 'select', 'stat', 'signal', 'sys', 'time'])
        self.assertEqual([(node.module, [alias.name for alias in node.names]) for node in tree.body if isinstance(node, ast.ImportFrom)], [('pathlib', ['Path'])])
        self.assertEqual([node.targets[0].id for node in tree.body if isinstance(node, ast.Assign)], ['REASONS'])
        self.assertEqual([type(node).__name__ for node in tree.body if not isinstance(node, (ast.Import, ast.ImportFrom, ast.Assign, ast.FunctionDef))], ['Expr'])
        self.assertIsInstance(tree.body[0], ast.Expr)
        self.assertIsInstance(tree.body[0].value, ast.Constant)
        self.assertIsInstance(tree.body[0].value.value, str)
        self.assertFalse(any(isinstance(node, ast.If) for node in tree.body))
        # Patch the ACTUAL shared function globals: a CLI alias would be a no-op.
        # Refusal must precede subreaper admission and any fork/native workload.
        with patch.object(kernel, 'own_children', return_value=[123]), patch.object(kernel, 'subreaper') as admission:
            with self.assertRaises(ValueError):
                module.supervise([sys.executable, '-I', '-B', '-c', 'pass'], .1, lambda _: None)
            admission.assert_not_called()

    def test_actual_fixed_loader_executes_source_despite_valid_poison_cache_and_search_path_hooks(self):
        folder = Path(__file__).resolve().parent
        with tempfile.TemporaryDirectory(prefix='aihr-owned-kernel-cache-') as name:
            private = Path(name).resolve(); source = private / 'controller'; source.mkdir()
            adapter = source / 'employee-benchmark-supervisor.py'
            kernel = source / 'owned-process.py'
            adapter.write_bytes((folder / adapter.name).read_bytes())
            kernel.write_bytes((folder / kernel.name).read_bytes())
            registry = source / 'employee-lifecycle-profile.json'
            registry.write_bytes((folder / registry.name).read_bytes())
            cached = Path(importlib.util.cache_from_source(str(kernel)))
            cached.parent.mkdir()
            poison = compile("raise RuntimeError('MODEL_POISON_PYC')", str(kernel), 'exec', dont_inherit=True)
            actual = kernel.stat()
            # CPython timestamp/size header matches the REAL source file exactly.
            # This is a private negative-control fixture, never a repository pyc.
            cached.write_bytes(importlib.util.MAGIC_NUMBER + struct.pack('<III', 0, int(actual.st_mtime) & 0xffffffff, actual.st_size) + marshal.dumps(poison))
            old = importlib.util.spec_from_file_location('old_cache_reader_control', kernel)
            old_module = importlib.util.module_from_spec(old)
            with self.assertRaisesRegex(RuntimeError, '^MODEL_POISON_PYC$'):
                old.loader.exec_module(old_module)
            hook = private / 'untrusted-search'; hook.mkdir()
            for filename in ('owned-process.py', 'owned_process.py', 'aihr_owned_process.py'):
                (hook / filename).write_text("raise RuntimeError('MODEL_SEARCH_PATH_HOOK')")
            fixed = ModuleType('actual_fixed_adapter_control'); fixed.__file__ = str(adapter)
            before = Path.cwd()
            try:
                os.chdir(hook)
                with patch.object(sys, 'path', [str(hook), *sys.path]), patch.dict(os.environ, {'PYTHONPATH': str(hook)}):
                    # Run the ACTUAL adapter source, including its fixed loader;
                    # __name__ is not __main__, so no closed hosted CLI is called.
                    exec(compile(adapter.read_bytes(), str(adapter), 'exec', dont_inherit=True), fixed.__dict__)
            finally:
                os.chdir(before)
            self.assertEqual(Path(fixed._owned_process.__file__), kernel)
            self.assertIs(fixed.supervise.__globals__, fixed._owned_process.__dict__)
            self.assertEqual(fixed.supervise.__code__.co_filename, str(kernel))
            self.assertEqual(fixed._owned_process.REASONS, module._owned_process.REASONS)
            self.assertEqual(kernel.read_bytes(), (folder / kernel.name).read_bytes())
            self.assertEqual(registry.read_bytes(), (folder / registry.name).read_bytes())
            self.assertEqual(cached.read_bytes(), importlib.util.MAGIC_NUMBER + struct.pack('<III', 0, int(actual.st_mtime) & 0xffffffff, actual.st_size) + marshal.dumps(poison))

if __name__ == '__main__':
    unittest.main()
