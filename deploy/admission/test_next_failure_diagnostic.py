"""Source/read-only child models; never root, systemd, Next, DB or a release witness."""
import ast
import copy
import hashlib
import importlib.util
import json
import pathlib
import subprocess
import stat
import sys
import time
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('owned_next_failure_model', pathlib.Path(__file__).with_name('test_next_native.py'))
F = importlib.util.module_from_spec(spec)
spec.loader.exec_module(F)


class FailureDiagnosticModels(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.path = str(pathlib.Path(F.__file__).absolute())
        cls.sources = {'fixture': pathlib.Path(cls.path).read_bytes()}
        cls.sources.update({owner: pathlib.Path(__file__).with_name(pathlib.Path(path).name).read_bytes()
                            for owner, path in F.OBSERVER_PATHS.items() if owner != 'inventory'})
        cls.sources['inventory'] = pathlib.Path('.github/ci/runtime_inventory.py').read_bytes()
        cls.catalog, cls.reasons = F.runtime_catalog(cls.sources, cls.path)
        cls.binding = {'helpers': {pathlib.Path(cls.path if owner == 'fixture' else F.OBSERVER_PATHS[owner]).name:
            {'sha256': hashlib.sha256(raw).hexdigest()} for owner, raw in cls.sources.items()}}

    def setUp(self):
        self.report = F.report
        F.report = {'phases': [], 'currentPhase': 'actual-browser-start-first'}

    def tearDown(self):
        F.report = self.report

    def state(self, changes=None):
        rows = []
        for unit in F.RUNTIME_DIAGNOSTIC_UNITS:
            value = dict(Id=unit, LoadState='loaded', ActiveState='failed', SubState='failed',
                         InvocationID='a'*32, MainPID='0', ControlPID='0', Result='exit-code',
                         ExecMainCode='1', ExecMainStatus='1')
            if changes:
                value.update(changes)
            rows.append('\n'.join(key+'='+text for key, text in value.items()))
        return ('\n\n'.join(rows)+'\n').encode()

    def journal(self, message=None, **changes):
        row = {'_UID': '0', '_EXE': '/usr/bin/python3.12', '_SYSTEMD_UNIT': F.UNITS[0],
               '_SYSTEMD_INVOCATION_ID': 'a'*32, '_CMDLINE': '/usr/bin/python3 -I -B '+F.OBSERVER_PATHS['controller']+' reserve '+F.UNITS[0],
               'MESSAGE': message if message is not None else next(iter(self.reasons))}
        row.update(changes)
        return (json.dumps(row)+'\n').encode()

    def classify(self, raw):
        return F.runtime_journal_observation(raw, F.UNITS[0], 'a'*32, '/usr/bin/python3.12', self.reasons)

    def native_error(self):
        with patch.object(F.subprocess, 'run', return_value=types.SimpleNamespace(returncode=1)):
            try:
                F.run(['/usr/bin/systemctl', '--system', 'start', F.UNITS[0]])
            except AssertionError as error:
                return error
        self.fail('Original fixed native return-code guard did not refuse')

    def test_closed_command_labels_and_numeric_return_codes_do_not_reflect_arguments(self):
        for unit, label in F.RUNTIME_DIAGNOSTIC_UNITS.items():
            self.assertEqual(F.runtime_command_label(['/usr/bin/systemctl', '--system', 'stop', unit]), 'stop-'+label)
        for arguments in (['/private/TOKEN=fictional'], ['/usr/bin/systemctl', '--system', 'stop', 'foreign-secret.service'], {}):
            self.assertIsNone(F.runtime_command_label(arguments))
        F.runtime_command_observation(['/usr/bin/systemctl', '--system', 'start', F.UNITS[0]], types.SimpleNamespace(returncode=7))
        self.assertEqual(F.report['runtimeCommands'], [{'command': 'start-worker-1', 'returnCode': 7, 'outcome': 'returned'}])

    def test_actual_run_keeps_original_assertion_and_actual_result_object(self):
        result = types.SimpleNamespace(returncode=7, stdout=b'fictional-private', stderr=b'fictional-private')
        args = ['/usr/bin/systemctl', '--system', 'start', F.UNITS[0]]
        with patch.object(F.subprocess, 'run', return_value=result):
            with self.assertRaisesRegex(AssertionError, '^Bounded native subprocess refused$'):
                F.run(args)
            self.assertIs(F.run(args, check=False), result)
        self.assertEqual(F.report['runtimeCommands'][0]['returnCode'], 7)
        self.assertNotIn('fictional-private', json.dumps(F.report))

    def test_actual_run_timeout_preserves_original_identity_and_redacts_private_arguments(self):
        error = subprocess.TimeoutExpired('/private/TOKEN=fictional', 30, stderr=b'fictional-private')
        with patch.object(F.subprocess, 'run', side_effect=error):
            try:
                F.run(['/usr/bin/systemctl', '--system', 'start', F.UNITS[0]])
            except BaseException as caught:
                self.assertIs(caught, error)
            else:
                self.fail('Original timeout was swallowed')
        self.assertEqual(F.report['runtimeCommands'][0]['outcome'], 'timeout')
        self.assertNotIn('fictional', json.dumps(F.report))

    def test_all_three_actual_source_owners_contribute_exact_literal_guard_sites(self):
        owners = {site['owner'] for sites in self.reasons.values() for site in sites}
        self.assertEqual(owners, set(F.OBSERVER_PATHS))
        for owner, filename in F.OBSERVER_PATHS.items():
            tree = ast.parse(self.sources[owner], filename)
            for node in ast.walk(tree):
                if isinstance(node, ast.Call) and len(node.args) == 2 and isinstance(node.args[1], ast.Constant):
                    sites = self.reasons.get('Admission refused: '+str(node.args[1].value), [])
                    for site in sites:
                        if site['owner'] == owner and site['line'] == node.lineno:
                            self.assertIsInstance(node.args[1].value, str)

    def test_actual_fixture_refusal_records_only_authenticated_code_and_ast_call_locations(self):
        error = self.native_error()
        value = F.runtime_exception_observation(error, self.catalog)
        self.assertEqual(value['classification'], 'sealed-source-exception')
        self.assertEqual(value['exception'], 'AssertionError')
        self.assertTrue(any(row['owner'] == 'fixture' and row['kind'] == 'guard' for row in value['frames']))
        self.assertNotIn('Bounded native subprocess refused', json.dumps(value))

    def test_forged_filename_and_globals_do_not_replace_actual_sealed_code_identity(self):
        namespace = {'__file__': self.path, 'private': '/private/TOKEN=fictional'}
        exec(compile('def foreign():\n raise AssertionError(private)\n', self.path, 'exec'), namespace)
        try:
            namespace['foreign']()
        except AssertionError as error:
            value = F.runtime_exception_observation(error, self.catalog)
        self.assertEqual(value['classification'], 'unmatched-source-exception')
        self.assertEqual(value['frames'], [])
        self.assertNotIn('fictional', json.dumps(value))

    def test_exact_root_controller_message_maps_to_all_source_bound_sites(self):
        for owner in F.OBSERVER_PATHS:
            message = next(message for message, sites in self.reasons.items() if any(site['owner'] == owner for site in sites))
            value = self.classify(self.journal(message))
            self.assertEqual(value['trustedControllerRecords'], 1)
            self.assertEqual(value['literalRefusals'], [{'classification': 'sealed-literal-refusal', 'sites': self.reasons[message]}])
            self.assertNotIn(message, json.dumps(value))

    def test_every_foreign_native_identity_prevents_a_literal_classification(self):
        for change in ({'_UID':'65534'}, {'_EXE':'/tmp/python'}, {'_SYSTEMD_UNIT':F.UNITS[1]},
                       {'_SYSTEMD_INVOCATION_ID':'b'*32}, {'_CMDLINE':'python3 private.py'}, {'_CMDLINE':[]},
                       {'_UID':0}, {'_EXE':[]}, {'_SYSTEMD_INVOCATION_ID':None}):
            value = self.classify(self.journal(**change))
            self.assertEqual(value['trustedControllerRecords'], 0)
            self.assertEqual(value['literalRefusals'], [])

    def test_private_unknown_suffixed_newline_and_binary_messages_never_enter_evidence(self):
        message = next(iter(self.reasons))
        for value in ('/private/TOKEN=fictional', message+' private', message+'\n', message+'\r\n', ['binary', 255]):
            result = self.classify(self.journal(value))
            self.assertEqual(result['literalRefusals'], [])
            self.assertNotIn('fictional', json.dumps(result))

    def test_only_exact_closed_controller_exception_classes_are_reported(self):
        result = self.classify(self.journal('Admission failed: AssertionError; reconcile before retry'))
        self.assertEqual(result['closedExceptions'], ['AssertionError'])
        self.assertEqual(self.classify(self.journal('Admission failed: fictional-private; reconcile before retry'))['closedExceptions'], [])

    def test_fixed_complete_state_snapshot_keeps_only_closed_states_and_exit_scalars(self):
        result, invocations = F.runtime_state_observation(self.state())
        self.assertEqual(len(result), 5)
        self.assertEqual(set(invocations), set(F.UNITS))
        self.assertTrue(all(row['ExecMainStatus'] == 1 and row['ExecMainCode'] == 1 for row in result))
        result, _ = F.runtime_state_observation(self.state({'SubState':'private-TOKEN', 'Result':'private-TOKEN', 'ExecMainStatus':'private-TOKEN'}))
        self.assertTrue(all(row['SubState'] == 'unknown' and row['Result'] == 'unknown' and row['ExecMainStatus'] is None for row in result))
        self.assertNotIn('private', json.dumps(result))

    def test_partial_duplicate_extra_or_foreign_state_records_refuse_without_raw_values(self):
        raw = self.state()
        for altered in (raw.split(b'\n\n')[0], raw+raw, raw.replace(b'Id=', b'Private=', 1), raw.replace(F.UNITS[0].encode(), b'foreign.service', 1)):
            with self.assertRaises((AssertionError, UnicodeError)):
                F.runtime_state_observation(altered)
        with self.assertRaises(AssertionError):
            self.classify(self.journal()*65)

    def test_primary_and_cleanup_diagnostics_stay_separate_and_io_cannot_reclassify_failure(self):
        error = self.native_error()
        paths = dict(F.OBSERVER_PATHS, fixture=self.path)
        by_path = {path:self.sources[owner] for owner,path in paths.items()}
        with patch.object(F, 'observer_read', side_effect=lambda path, _bound: by_path[str(path)]), \
             patch.object(F, 'runtime_diagnostic_read', side_effect=OSError('/private/TOKEN=fictional')):
            F.runtime_failure_diagnostic('primary', error, self.binding)
            F.runtime_failure_diagnostic('cleanup', error, self.binding)
        values = F.report['runtimeFailureDiagnostics']
        self.assertEqual(set(values), {'primary', 'cleanup'})
        self.assertTrue(all(row['incomplete'] and row['exception']['classification'] == 'sealed-source-exception' for row in values.values()))
        self.assertNotIn('ownedRuntimeCleaned', F.report)
        self.assertNotIn('fictional', json.dumps(F.report))

    def test_source_drift_or_expired_work_budget_cannot_start_a_diagnostic_command(self):
        error = self.native_error()
        with patch.object(F, 'observer_read', return_value=b'foreign-source'), patch.object(F, 'runtime_diagnostic_read') as native:
            F.runtime_failure_diagnostic('primary', error, self.binding)
            native.assert_not_called()
        with patch.object(F, 'DEADLINE', time.monotonic()-1), patch.object(F, 'observer_read') as source, patch.object(F, 'runtime_diagnostic_read') as native:
            F.runtime_failure_diagnostic('cleanup', error, self.binding)
            source.assert_not_called()
            native.assert_not_called()
        self.assertEqual(F.report['runtimeFailureDiagnostics']['cleanup']['classification'], 'unavailable')
        self.assertNotIn('ownedRuntimeCleaned', F.report)

    def test_bounded_reader_reaps_its_actual_unprivileged_child_on_overflow_and_deadline(self):
        original = subprocess.Popen
        children = []
        def spawn(*args, **kwargs):
            child = original(*args, **kwargs)
            children.append(child)
            return child
        with patch.object(F.subprocess, 'Popen', side_effect=spawn):
            with self.assertRaisesRegex(AssertionError, 'pipe bound'):
                F.runtime_diagnostic_read([sys.executable, '-I', '-B', '-c', "import os;os.write(1,b'x'*131073)"], time.monotonic()+2)
            with self.assertRaises(TimeoutError):
                F.runtime_diagnostic_read([sys.executable, '-I', '-B', '-c', 'import time;time.sleep(10)'], time.monotonic()+0.2)
        self.assertEqual(len(children), 2)
        self.assertTrue(all(child.returncode is not None for child in children))
        self.assertNotIn('diagnosticChildrenSettled', F.report)

    def test_reader_retains_actual_nonzero_exit_without_uploading_private_bytes(self):
        code, raw = F.runtime_diagnostic_read([sys.executable, '-I', '-B', '-c', "import sys;sys.stdout.write('fictional-private');sys.exit(7)"], time.monotonic()+2)
        self.assertEqual((code, raw), (7, b'fictional-private'))
        self.assertNotIn('fictional', json.dumps(F.report))

    def test_selector_creation_failure_still_reaps_the_already_created_actual_child(self):
        original = subprocess.Popen
        children = []
        def spawn(*args, **kwargs):
            child = original(*args, **kwargs)
            children.append(child)
            return child
        failure = OSError('fictional-private-selector')
        with patch.object(F.subprocess, 'Popen', side_effect=spawn), patch.object(F.selectors, 'DefaultSelector', side_effect=failure):
            try:
                F.runtime_diagnostic_read([sys.executable, '-I', '-B', '-c', 'import time;time.sleep(10)'], time.monotonic()+2)
            except OSError as caught:
                self.assertIs(caught, failure)
            else:
                self.fail('Selector failure was swallowed')
        self.assertEqual(len(children), 1)
        self.assertIsNotNone(children[0].returncode)
        self.assertNotIn('fictional', json.dumps(F.report))

    def test_kill_failure_cannot_skip_wait_or_pipe_close_and_never_exposes_its_message(self):
        steps = []
        class Child:
            stdout = types.SimpleNamespace(close=lambda: steps.append('pipe-close'))
            def kill(self):
                steps.append('kill')
                raise OSError('fictional-private-kill')
            def wait(self, timeout):
                steps.append('wait')
                return 0
        with patch.object(F.subprocess, 'Popen', return_value=Child()), \
             patch.object(F.selectors, 'DefaultSelector', side_effect=OSError('fictional-private-selector')):
            with self.assertRaisesRegex(RuntimeError, '^Bounded diagnostic transport cleanup refused$'):
                F.runtime_diagnostic_read(['/fixed-model-only'], time.monotonic()+2)
        self.assertEqual(steps, ['kill', 'wait', 'pipe-close'])
        self.assertNotIn('fictional', json.dumps(F.report))

    def owned_diagnostic(self, owned, change_during_journal=False, initial_drift=None):
        # IO-routing models only, not actual root/systemd ownership evidence.
        # The real ownership predicate still executes; native file facts are
        # supplied at the filesystem boundary, never as a caller verified flag.
        calls, drift = [], {'changed': False}
        paths = dict(F.OBSERVER_PATHS, fixture=self.path)
        by_path = {path: self.sources[owner] for owner, path in paths.items()}
        original_lstat = pathlib.Path.lstat
        python_exe = str(pathlib.Path('/usr/bin/python3').resolve(strict=True))
        def lstat(path, *args, **kwargs):
            if path.parent == pathlib.Path('/etc/systemd/system') and path.name in F.RUNTIME_DIAGNOSTIC_UNITS:
                self.assertIn(path.name, owned, 'Unowned declaration must not be inspected as positive ownership')
                value = dict(st_mode=stat.S_IFREG | 0o644, st_uid=0,
                             st_dev=owned[path.name][0], st_ino=owned[path.name][1])
                if initial_drift:
                    value.update(initial_drift)
                if drift['changed']:
                    value['st_ino'] += 1
                return types.SimpleNamespace(**value)
            return original_lstat(path, *args, **kwargs)
        def read(arguments, _deadline):
            calls.append(arguments)
            if arguments[0] == '/usr/bin/systemctl':
                return 0, self.state()
            self.assertEqual(arguments[0], '/usr/bin/journalctl')
            unit = next(value.split('=', 1)[1] for value in arguments if value.startswith('_SYSTEMD_UNIT='))
            if change_during_journal:
                drift['changed'] = True
            return 0, self.journal(_SYSTEMD_UNIT=unit, _EXE=python_exe,
                _CMDLINE='/usr/bin/python3 -I -B '+F.OBSERVER_PATHS['controller']+' reserve '+unit)
        with patch.object(F, 'owned_units', owned), \
             patch.object(F, 'observer_read', side_effect=lambda path, _bound: by_path[str(path)]), \
             patch.object(pathlib.Path, 'lstat', autospec=True, side_effect=lstat), \
             patch.object(F, 'runtime_diagnostic_read', side_effect=read), \
             patch.object(F, 'runtime_journal_observation', wraps=F.runtime_journal_observation) as classify:
            F.runtime_failure_diagnostic('primary', self.native_error(), self.binding)
        return F.report['runtimeFailureDiagnostics']['primary'], calls, classify

    def test_empty_ownership_never_reads_or_classifies_same_named_foreign_invocations(self):
        value, calls, classify = self.owned_diagnostic({})
        self.assertEqual([row[0] for row in calls], ['/usr/bin/systemctl'])
        classify.assert_not_called()
        self.assertEqual(value['journals'], [])
        self.assertEqual(value['statesScope'], 'fixed-unit-snapshot-not-ownership')
        self.assertEqual(value['unavailableWorkerJournals'], [
            {'unit': 'worker-1', 'reason': 'unowned-declaration'},
            {'unit': 'worker-2', 'reason': 'unowned-declaration'}])
        self.assertNotIn('ownedRuntimeCleaned', F.report)

    def test_partial_ownership_reads_and_classifies_only_the_exact_captured_worker(self):
        value, calls, classify = self.owned_diagnostic({F.UNITS[0]: (11, 22)})
        journals = [row for row in calls if row[0] == '/usr/bin/journalctl']
        self.assertEqual(len(journals), 1)
        self.assertIn('_SYSTEMD_UNIT='+F.UNITS[0], journals[0])
        self.assertFalse(any('_SYSTEMD_UNIT='+F.UNITS[1] in row for row in calls))
        self.assertEqual(classify.call_count, 1)
        self.assertEqual(classify.call_args.args[1], F.UNITS[0])
        self.assertEqual([row['unit'] for row in value['journals']], ['worker-1'])
        self.assertEqual(value['journals'][0]['trustedControllerRecords'], 1)
        self.assertEqual(value['unavailableWorkerJournals'], [{'unit': 'worker-2', 'reason': 'unowned-declaration'}])

    def test_current_native_declaration_drift_refuses_before_read_and_again_before_classification(self):
        for changed in ({'st_uid': 65534}, {'st_mode': stat.S_IFREG | 0o666},
                        {'st_mode': stat.S_IFLNK | 0o777}, {'st_dev': 12}, {'st_ino': 23}):
            value, calls, classify = self.owned_diagnostic({F.UNITS[0]: (11, 22)}, initial_drift=changed)
            self.assertTrue(value['incomplete'])
            self.assertEqual(calls, [])
            classify.assert_not_called()
        value, calls, classify = self.owned_diagnostic({F.UNITS[0]: (11, 22)}, change_during_journal=True)
        self.assertTrue(value['incomplete'])
        self.assertEqual(len([row for row in calls if row[0] == '/usr/bin/journalctl']), 1)
        classify.assert_not_called()
        self.assertNotIn('journals', value)
        self.assertNotIn('ownedRuntimeCleaned', F.report)

    def test_complete_original_native_authority_and_cleanup_source_bytes_are_preserved(self):
        source = self.sources['fixture'].decode()
        # Verify/reverse the complete new observation layer, then the existing
        # CPU constructor layer, before the original cleanup inverse consumes it.
        for filename in ('next_key_name_digest_inverse.json', 'next_phase_observation_inverse.json', 'next_environment_observation_inverse.json', 'next_cpu_weight_constructor_inverse.json'):
            layer = json.loads(pathlib.Path(__file__).with_name(filename).read_text())
            row = layer['files']['deploy/admission/test_next_native.py']
            self.assertEqual(hashlib.sha256(source.encode()).hexdigest(), row['currentSha256'])
            lines, frontier = source.splitlines(keepends=True), len(source.splitlines(keepends=True))
            for edit in row['changes']:
                self.assertTrue(0 <= edit['start'] <= edit['end'] <= frontier)
                self.assertEqual(''.join(lines[edit['start']:edit['end']]), edit['after'])
                lines[edit['start']:edit['end']] = edit['before'].splitlines(keepends=True);frontier = edit['start']
            source = ''.join(lines)
            self.assertEqual(hashlib.sha256(source.encode()).hexdigest(), row['originalSha256'])
        repair = json.loads(pathlib.Path(__file__).with_name('next_cleanup_phase_inverse.json').read_text())
        self.assertEqual(repair['base'], 'f37f9d629458b7d2bf4a34bdb3a0891e32af96e2')
        row = repair['files']['deploy/admission/test_next_native.py']
        self.assertEqual(row['originalSha256'], '730f34682797f8ecef52b98181ab12f786081caebe1d24f1552d24d6d4ef8632')
        self.assertEqual(hashlib.sha256(source.encode()).hexdigest(), row['currentSha256'])
        for change in reversed(row['changes']):
            self.assertEqual(source.count(change['after']), 1)
            source = source.replace(change['after'], change['before'])
        self.assertEqual(hashlib.sha256(source.encode()).hexdigest(), row['originalSha256'])
        begin = source.index('\ndef record_owned_invocation(')
        finish = source.index('\n\n# Read-only failure diagnostics.', begin)
        self.assertEqual(hashlib.sha256(source[begin:finish].encode()).hexdigest(), 'aaabbea8bdff81e1b17d4a69c564613ee75a37638692d90d15238eca8a83e7a5')
        original_cleanup = pathlib.Path(__file__).with_name('next_cleanup_57d.source').read_text()
        source = source[:begin] + '\n' + original_cleanup + source[finish:]
        self.assertEqual(source.count('owned_paths, owned_units, owned_invocations = {}, {}, {}'), 1)
        source = source.replace('owned_paths, owned_units, owned_invocations = {}, {}, {}', 'owned_paths, owned_units = {}, {}')
        self.assertEqual(source.count('browser = None\nmanaged_runtime_module = None'), 1)
        source = source.replace('browser = None\nmanaged_runtime_module = None', 'browser = None')
        self.assertEqual(source.count('    global managed_runtime_module\n    managed_runtime_module = N\n'), 1)
        source = source.replace('    global managed_runtime_module\n    managed_runtime_module = N\n', '')
        self.assertEqual(source.count("        '--property=TimeoutStopSec=3s', '--property=SendSIGKILL=yes', '--property=RuntimeMaxSec=300s',\n"), 1)
        source = source.replace("        '--property=TimeoutStopSec=3s', '--property=SendSIGKILL=yes', '--property=RuntimeMaxSec=300s',\n", '')
        self.assertEqual(source.count('    owned_start(PROXY, timeout=60)'), 1)
        source = source.replace('    owned_start(PROXY, timeout=60)', "    systemctl('start', PROXY, timeout=60)")
        self.assertEqual(source.count('                owned_start(UNITS[0], timeout=90)'), 1)
        source = source.replace('                owned_start(UNITS[0], timeout=90)', "                systemctl('start', UNITS[0], timeout=90)")
        self.assertEqual(source.count('                owned_start(UNITS[1], nonblocking=True)'), 1)
        source = source.replace('                owned_start(UNITS[1], nonblocking=True)', "                systemctl('start', '--no-block', UNITS[1])")
        self.assertEqual(source.count("    until(lambda: record_owned_invocation(BROWSER, transient=True), 'owned native browser invocation', seconds=5)\n"), 1)
        source = source.replace("    until(lambda: record_owned_invocation(BROWSER, transient=True), 'owned native browser invocation', seconds=5)\n", '')
        self.assertEqual(source.count('def require_stopped(unit, actual=None):\n    if actual is None:\n        actual = props(unit)'), 1)
        source = source.replace('def require_stopped(unit, actual=None):\n    if actual is None:\n        actual = props(unit)', 'def require_stopped(unit):\n    actual = props(unit)')
        self.assertEqual(source.count('    primary_failure = None\n'), 1)
        source = source.replace('    primary_failure = None\n', '')
        self.assertEqual(source.count('        primary_failure = error\n'), 1)
        source = source.replace('        primary_failure = error\n', '')
        self.assertEqual(source.count("            if primary_failure is not None:\n                raise BaseExceptionGroup('Native Next operation and owned cleanup both refused', [primary_failure, error])\n"), 1)
        source = source.replace("            if primary_failure is not None:\n                raise BaseExceptionGroup('Native Next operation and owned cleanup both refused', [primary_failure, error])\n", '')
        self.assertEqual(hashlib.sha256(source.encode()).hexdigest(), 'f3acb4eec66245356ef8945425d1e17077bba0e451f75449ab5b5065f994f4c2')
        start = source.index('\n# Read-only failure diagnostics.')
        end = source.index('\ndef main():', start)
        restored = source[:start]+source[end:]
        new = """    try:
        result = subprocess.run(arguments, env=SAFE_ENV if env is None else env, input=input,
                                capture_output=True, timeout=left(timeout), cwd=cwd)
    except BaseException as error:
        runtime_command_observation(arguments, error=error)
        raise
    runtime_command_observation(arguments, result=result)
"""
        old = """    result = subprocess.run(arguments, env=SAFE_ENV if env is None else env, input=input,
                            capture_output=True, timeout=left(timeout), cwd=cwd)
"""
        self.assertEqual(restored.count(new), 1)
        restored = restored.replace(new, old).replace("        runtime_failure_diagnostic('primary', error, binding)\n", '').replace("            runtime_failure_diagnostic('cleanup', error, binding)\n", '')
        restored = restored.replace("        except BaseException as error:\n            report['ownedRuntimeCleaned'] = False", "        except BaseException:\n            report['ownedRuntimeCleaned'] = False")
        self.assertEqual(hashlib.sha256(restored.encode()).hexdigest(), '8a22a9ebdaab88fccaf53a47ec517763e52073880877672074840f72d41cf181')


if __name__ == '__main__':
    unittest.main()
