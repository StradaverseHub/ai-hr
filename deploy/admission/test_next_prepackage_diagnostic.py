"""Stdlib source models only: never root, systemd, a Next process or a build witness."""
import copy
import contextlib
import importlib.util
import json
import os
import pathlib
import tempfile
import subprocess
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('owned_next_diagnostic_model', pathlib.Path(__file__).with_name('test_next_native.py'))
F = importlib.util.module_from_spec(spec)
spec.loader.exec_module(F)


class PrepackageDiagnosticModels(unittest.TestCase):
    def setUp(self):
        self.original = F.report
        F.report = {'phases': []}
        self.saved = []
        self.save = patch.object(F, 'save', side_effect=lambda: self.saved.append(copy.deepcopy(F.report)))
        self.save.start()

    def tearDown(self):
        self.save.stop()
        F.report = self.original

    def test_every_fixed_guard_retains_a_real_refusal_and_only_its_bound_public_labels(self):
        for code, stage in F.PREPACKAGE_GUARDS.items():
            F.report = {'phases': []}
            F.prepackage_phase(stage)
            with self.assertRaisesRegex(AssertionError, '^Closed native prepackage guard refused$'):
                F.prepackage_guard(False, code)
            self.assertEqual(F.report, {'phases': ['prepackage-' + stage], 'currentPhase': 'prepackage-' + stage,
                                       'prepackageGuardFailure': {'stage': stage, 'code': code}})

    def test_unknown_code_or_stage_never_enters_evidence_or_exception_text(self):
        secret = '/fictional/private/path?TOKEN=fictional-sensitive-value'
        for unknown in (secret, {}, None):
            for call in (lambda: F.prepackage_phase(unknown), lambda: F.prepackage_guard(False, unknown)):
                before = copy.deepcopy(F.report)
                with self.assertRaises(AssertionError) as refusal:
                    call()
                self.assertNotIn(secret, str(refusal.exception))
                self.assertEqual(F.report, before)
        self.assertEqual(self.saved, [])

    def test_valid_code_in_a_foreign_phase_refuses_without_a_misleading_guard_record(self):
        F.prepackage_phase('empty-home')
        before = copy.deepcopy(F.report)
        with self.assertRaisesRegex(AssertionError, '^Native prepackage guard phase differs$'):
            F.prepackage_guard(False, 'node-stat')
        self.assertEqual(F.report, before)

    def test_successful_guard_does_not_mint_a_failure_or_execute_a_native_operation(self):
        F.prepackage_phase('node-read')
        F.prepackage_guard(True, 'node-installed-bytes')
        self.assertNotIn('prepackageGuardFailure', F.report)
        self.assertEqual(len(self.saved), 1)

    def test_actual_directory_function_keeps_all_service_units_strictly_absent(self):
        with patch.object(F.os.path, 'lexists', return_value=False), \
             patch.object(F, 'props', return_value={'LoadState': 'loaded'}), \
             patch.object(F.os, 'mkdir') as mkdir:
            with self.assertRaisesRegex(AssertionError, '^Closed native prepackage guard refused$'):
                F.fixture_directories()
            mkdir.assert_not_called()
        self.assertEqual(F.report['prepackageGuardFailure'], {'stage': 'unit-absence', 'code': 'fixture-unit-0'})
        self.assertNotIn('fictional-sensitive-value', json.dumps(self.saved))

    @contextlib.contextmanager
    def slice_host(self, changes=None, members=None, kernel=False, raw=None):
        # Injected manager observations only. Real temporary descriptor leaf
        # checks run; root ownership admission is exercised separately below.
        metadata = {'Id': F.SLICE, 'LoadState': 'loaded', 'ActiveState': 'inactive', 'SubState': 'dead',
                    'FragmentPath': '', 'SourcePath': '', 'DropInPaths': '', 'Transient': 'no',
                    'ControlGroup': '', 'Following': ''}
        metadata.update(changes or {})
        def systemctl(*args):
            if args[1:2] == (F.SLICE,):
                data = raw if raw is not None else ('\n'.join(key + '=' + value for key, value in metadata.items()) + '\n').encode()
            elif args == ('show', '--property=UnitPath', '--value'):
                data = b'/etc/systemd/system\n'
            else:
                self.assertEqual(args, ('show', '--all', '--no-pager', '--property=Id,Slice', '*.service', '*.scope'))
                data = members if members is not None else b'Id=systemd-journald.service\nSlice=system.slice\n\nId=init.scope\nSlice=-.slice\n'
            return types.SimpleNamespace(stdout=data)
        with tempfile.TemporaryDirectory() as temporary:
            descriptor = os.open(temporary, os.O_RDONLY | os.O_DIRECTORY)
            try:
                with patch.object(F, 'systemctl', side_effect=systemctl), \
                     patch.object(F, 'manager_directory', side_effect=lambda _path: contextlib.nullcontext(descriptor)), \
                     patch.object(F.os.path, 'lexists', return_value=kernel):
                    yield pathlib.Path(temporary)
            finally:
                os.close(descriptor)

    def test_clean_implicit_slice_requires_all_actual_host_observations_before_admission(self):
        with self.slice_host():
            F.slice_absence()
        self.assertEqual(F.report['slicePreflight'], {'fixedImplicitSliceAbsenceVerified': True,
                         'lookupDirectories': 1, 'associatedUnitsInspected': 2, 'existingKernelCgroup': False})
        self.assertNotIn('prepackageGuardFailure', F.report)

    def test_fragment_dropin_transient_active_cgroup_alias_and_foreign_identity_refuse(self):
        for change in ({'Id': 'foreign.slice'}, {'FragmentPath': '/fictional/private/file'},
                       {'SourcePath': '/fictional/private/source'}, {'DropInPaths': '/fictional/private/dropin'},
                       {'Transient': 'yes'}, {'ActiveState': 'active'}, {'SubState': 'running'},
                       {'ControlGroup': F.FIXTURE_CGROUP}, {'Following': 'foreign.slice'}, {'LoadState': 'masked'}):
            F.report = {'phases': []}
            with self.slice_host(changes=change), self.assertRaises(AssertionError):
                F.slice_absence()
            self.assertEqual(F.report['prepackageGuardFailure']['code'], 'slice-metadata')
            self.assertNotIn('slicePreflight', F.report)
            self.assertNotIn('/fictional/private', json.dumps(self.saved))

    def test_incomplete_or_duplicate_manager_properties_never_form_an_absence_witness(self):
        for raw in (b'Id=aihr-native-next.slice\n', b'Id=aihr-native-next.slice\nId=aihr-native-next.slice\n', b'forged\n'):
            F.report = {'phases': []}
            with self.slice_host(raw=raw), self.assertRaises(AssertionError):
                F.slice_absence()
            self.assertNotIn('slicePreflight', F.report)

    def test_a_foreign_associated_service_or_scope_refuses_even_if_the_slice_is_inactive(self):
        for kind in ('service', 'scope'):
            F.report = {'phases': []}
            with self.slice_host(members=('Id=foreign.' + kind + '\nSlice=' + F.SLICE + '\n').encode()), self.assertRaises(AssertionError):
                F.slice_absence()
            self.assertEqual(F.report['prepackageGuardFailure']['code'], 'slice-member-units')

    def test_existing_kernel_cgroup_cannot_be_adopted_as_a_clean_implicit_slice(self):
        with self.slice_host(kernel=True), self.assertRaises(AssertionError):
            F.slice_absence()
        self.assertEqual(F.report['prepackageGuardFailure']['code'], 'slice-cgroup-absent')

    def test_real_unit_file_dropin_directory_and_dangling_link_are_all_refused(self):
        for kind in ('file', 'directory', 'link'):
            F.report = {'phases': []}
            with self.slice_host() as directory:
                target = directory / (F.SLICE + '.d' if kind == 'directory' else F.SLICE)
                if kind == 'file': target.write_text('foreign unit')
                elif kind == 'directory': target.mkdir()
                else: target.symlink_to('missing-foreign-fragment')
                with self.assertRaises(AssertionError): F.slice_absence()
            self.assertEqual(F.report['prepackageGuardFailure']['code'], 'slice-file-absent')

    def test_manager_directory_reader_admits_only_real_root_owned_system_lookup_paths(self):
        F.prepackage_phase('slice-absence')
        for path in ('/etc/systemd/system', '/lib/systemd/system'):
            with F.manager_directory(path) as descriptor:
                if descriptor is not None: self.assertEqual(os.fstat(descriptor).st_uid, 0)
        for path in ('/tmp/fictional', '/etc/systemd/../private', '/home/runner/system'):
            with self.assertRaises(AssertionError), F.manager_directory(path): pass

    def test_compiled_receiver_refusals_publish_only_exact_allowlisted_codes_never_child_output(self):
        binding = {'archivePath': '/private/archive', 'manifestPath': '/private/manifest', 'buildSourcePath': '/private/source'}
        for raw, code in [*F.FORMAT2_REFUSALS.items(), (b'private TOKEN=fictional\n', 'format2-receiver-refused'),
                          (next(iter(F.FORMAT2_REFUSALS)) + b'private TOKEN=fictional', 'format2-receiver-refused')]:
            F.report = {'phases': [], 'currentPhase': 'existing-format2-exact-receiver'}
            with patch.object(F, 'run', return_value=types.SimpleNamespace(returncode=1, stderr=raw)) as run:
                with self.assertRaisesRegex(AssertionError, '^Bounded compiled package receiver refused$'):
                    F.receive_compiled_package(pathlib.Path('/sealed'), binding, pathlib.Path('/release'))
                self.assertEqual(run.call_args.kwargs, {'timeout': 60, 'check': False})
            self.assertEqual(F.report['format2ReceiverFailure'], {'code': code})
            self.assertNotIn('TOKEN=', json.dumps(F.report))
        before = copy.deepcopy(F.report)
        F.report['currentPhase'] = 'foreign-phase'
        with patch.object(F, 'run') as run, self.assertRaises(AssertionError):
            F.receive_compiled_package(pathlib.Path('/sealed'), binding, pathlib.Path('/release'))
        run.assert_not_called()
        self.assertEqual(F.report['format2ReceiverFailure'], before['format2ReceiverFailure'])

    def test_compiled_receiver_success_and_timeout_keep_real_outcomes_and_private_redaction(self):
        binding = {'archivePath': '/private/archive', 'manifestPath': '/private/manifest', 'buildSourcePath': '/private/source'}
        F.report = {'phases': [], 'currentPhase': 'existing-format2-exact-receiver'}
        with patch.object(F, 'run', return_value=types.SimpleNamespace(returncode=0, stderr=b'private')):
            F.receive_compiled_package(pathlib.Path('/sealed'), binding, pathlib.Path('/release'))
        self.assertNotIn('format2ReceiverFailure', F.report)
        error = subprocess.TimeoutExpired('private TOKEN=fictional', 60, stderr=b'private TOKEN=fictional')
        with patch.object(F, 'run', side_effect=error), self.assertRaises(AssertionError) as refusal:
            F.receive_compiled_package(pathlib.Path('/sealed'), binding, pathlib.Path('/release'))
        self.assertEqual(F.report['format2ReceiverFailure'], {'code': 'format2-receiver-timeout'})
        self.assertNotIn('TOKEN=', str(refusal.exception) + json.dumps(F.report))

    def test_native_probe_launch_uses_only_fixed_copied_cwd_nonroot_and_closed_private_environment(self):
        F.report = {'phases': [], 'currentPhase': 'nonroot-stock-native-dependency-probe'}
        with patch.object(F, 'run', return_value=types.SimpleNamespace(returncode=0, stderr=b'', stdout=b'{"modelOnly":true}')) as run:
            self.assertEqual(F.native_dependency_probe('/owned/node', F.FIXED_RUNTIME), {'modelOnly': True})
            self.assertEqual(run.call_args.args[0], ['/usr/sbin/runuser', '-u', 'nobody', '--preserve-environment', '--',
                             '/owned/node', '--max-old-space-size=256', '/usr/local/lib/aihr-admission/next_dependency_probe.cjs',
                             '/var/lib/aihr-admission/release'])
            self.assertEqual(run.call_args.kwargs, {'timeout': 30, 'check': False, 'cwd': '/var/lib/aihr-admission/release',
                             'env': {'NODE_ENV': 'production', 'NEXT_TELEMETRY_DISABLED': '1', 'HOME': '/var/empty/aihr', 'PATH': '/usr/bin:/bin'}})
        for directory in ('/home/runner/work/ai-hr/ai-hr/source', '/foreign/runtime', '.'):
            with patch.object(F, 'run') as run, self.assertRaises(AssertionError):
                F.native_dependency_probe('/owned/node', pathlib.Path(directory))
            run.assert_not_called()
        F.report['currentPhase'] = 'foreign-phase'
        with patch.object(F, 'run') as run, self.assertRaises(AssertionError):
            F.native_dependency_probe('/owned/node', F.FIXED_RUNTIME)
        run.assert_not_called()

    def test_native_probe_diagnostics_require_exact_order_and_never_reflect_unknown_or_private_output(self):
        expected = ('admission', 'next-version', 'sharp-image', 'font-layout', 'next-config', 'executable-maps')
        self.assertEqual(F.PROBE_STAGES, expected)
        for index, stage in enumerate(expected):
            prefix = b''.join(F.PROBE_PROGRESS[:index + 1])
            failure = ('{"version":1,"kind":"NATIVE_DEPENDENCY_PROBE_REFUSAL","stage":"' + stage + '"}\n').encode()
            self.assertEqual(F.probe_diagnostic(prefix + failure), {'code': 'probe-' + stage, 'lastEnteredStage': stage})
            for raw in (b'private TOKEN=fictional', prefix + b'private /original/checkout TOKEN=fictional',
                        prefix + b'{"stage":"/private/TOKEN=fictional"}\n', prefix + b'private' * 20000):
                diagnostic = F.probe_diagnostic(raw)
                self.assertEqual(diagnostic['code'], 'probe-refused')
                self.assertNotIn('private', json.dumps(diagnostic))
                self.assertNotIn('TOKEN=', json.dumps(diagnostic))
            self.assertEqual(F.probe_diagnostic(failure), {'code': 'probe-refused'})
        self.assertEqual(F.probe_diagnostic(F.PROBE_PROGRESS[2]), {'code': 'probe-refused'})
        self.assertEqual(F.probe_diagnostic(None), {'code': 'probe-refused'})

    def test_native_probe_actual_refusal_and_timeout_stay_failures_with_only_owned_entered_stage(self):
        F.report = {'phases': [], 'currentPhase': 'nonroot-stock-native-dependency-probe'}
        prefix = b''.join(F.PROBE_PROGRESS[:3])
        failure = b'{"version":1,"kind":"NATIVE_DEPENDENCY_PROBE_REFUSAL","stage":"sharp-image"}\n'
        with patch.object(F, 'run', return_value=types.SimpleNamespace(returncode=1, stderr=prefix + failure)):
            with self.assertRaisesRegex(AssertionError, '^Bounded native dependency probe refused$'):
                F.native_dependency_probe('/owned/node', F.FIXED_RUNTIME)
        self.assertEqual(F.report['dependencyProbeFailure'], {'code': 'probe-sharp-image', 'lastEnteredStage': 'sharp-image'})
        error = subprocess.TimeoutExpired('private TOKEN=fictional', 30, stderr=prefix + b'private TOKEN=fictional')
        with patch.object(F, 'run', side_effect=error), self.assertRaises(AssertionError) as refusal:
            F.native_dependency_probe('/owned/node', F.FIXED_RUNTIME)
        self.assertEqual(F.report['dependencyProbeFailure'], {'code': 'probe-timeout', 'lastEnteredStage': 'sharp-image'})
        self.assertNotIn('TOKEN=', str(refusal.exception) + json.dumps(F.report))


    def test_configuration_stages_are_closed_and_unknown_values_never_enter_evidence(self):
        for stage in sorted(F.CONFIGURATION_STAGES):
            F.configuration_phase(stage)
            self.assertEqual(F.report['configuration'], {'stage': stage, 'declarationsVerified': False, 'actualNextBootVerified': False})
        before = copy.deepcopy(F.report)
        for stage in ('/private/TOKEN=fictional', None, {}):
            with self.assertRaises(AssertionError) as refusal:
                F.configuration_phase(stage)
            self.assertNotIn('TOKEN=', str(refusal.exception))
            self.assertEqual(F.report, before)

    def test_actual_configuration_wrapper_refuses_exact_controller_errors_with_only_closed_reasons(self):
        for message, code in F.CONFIGURATION_REASONS.items():
            F.report = {'currentPhase': 'protected-native-configuration'}
            F.configuration_phase('check-only')
            with patch.object(F, 'control', return_value=types.SimpleNamespace(returncode=1, stderr=('Admission refused: ' + message + '\n').encode())) as control:
                with self.assertRaisesRegex(AssertionError, '^Protected native configuration operation refused$'):
                    F.configuration_control('check-only')
                control.assert_called_once_with('check-only', check=False)
            self.assertEqual(F.report['configuration']['reason'], code)
            self.assertFalse(F.report['configuration']['declarationsVerified'])
            self.assertFalse(F.report['configuration']['actualNextBootVerified'])

    def test_private_unknown_suffixed_or_unbounded_configuration_errors_remain_generic_and_timeouts_remain_failures(self):
        known = ('Admission refused: ' + next(iter(F.CONFIGURATION_REASONS)) + '\n').encode()
        for raw in (b'/private/TOKEN=fictional', known + b'private', known.replace(b'\n', b'\r\n'), None, b'private' * 10000):
            F.report = {'currentPhase': 'protected-native-configuration'}
            F.configuration_phase('check-only')
            with patch.object(F, 'control', return_value=types.SimpleNamespace(returncode=1, stderr=raw)), self.assertRaises(AssertionError) as refusal:
                F.configuration_control('check-only')
            self.assertEqual(F.report['configuration']['reason'], 'controller-refused')
            self.assertNotIn('private', json.dumps(F.report) + str(refusal.exception))
        with patch.object(F, 'control', side_effect=subprocess.TimeoutExpired('private TOKEN=fictional', 60)), self.assertRaises(AssertionError) as refusal:
            F.configuration_control('check-only')
        self.assertEqual(F.report['configuration']['reason'], 'controller-timeout')
        self.assertNotIn('private', json.dumps(F.report) + str(refusal.exception))

    def test_successful_configuration_control_keeps_actual_return_and_unknown_or_wrong_phase_never_executes(self):
        result = types.SimpleNamespace(returncode=0, stdout=b'{"modelOnly":true}', stderr=b'private')
        for operation, stage in (('check-only', 'check-only'), ('status', 'empty-publication')):
            F.report = {'currentPhase': 'protected-native-configuration'}
            F.configuration_phase(stage)
            with patch.object(F, 'control', return_value=result) as control:
                self.assertIs(F.configuration_control(operation), result)
                control.assert_called_once_with(operation, check=False)
            self.assertNotIn('reason', F.report['configuration'])
        before = copy.deepcopy(F.report)
        for operation in ('initialize', 'private TOKEN=fictional', {}, None):
            with patch.object(F, 'control') as control, self.assertRaises(AssertionError):
                F.configuration_control(operation)
            control.assert_not_called()
        F.report['currentPhase'] = 'foreign-phase'
        with patch.object(F, 'control') as control, self.assertRaises(AssertionError):
            F.configuration_control('status')
        control.assert_not_called()
        self.assertEqual(F.report['configuration'], before['configuration'])


if __name__ == '__main__':
    unittest.main()
