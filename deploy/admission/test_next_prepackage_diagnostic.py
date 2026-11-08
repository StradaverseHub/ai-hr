"""Stdlib source models only: never root, systemd, a Next process or a build witness."""
import copy
import hashlib
import contextlib
import importlib.util
import json
import os
import pathlib
import tempfile
import subprocess
import sys
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

    def observer_sources(self):
        root = pathlib.Path(__file__).resolve().parents[2]
        return {owner: (root / name).read_bytes() for owner, name in {
            'controller': 'deploy/admission/controller.py', 'next-profile': 'deploy/admission/next_profile.py',
            'inventory': '.github/ci/runtime_inventory.py'}.items()}

    def observer_model(self, body):
        # Memory-only model code: never an installed source/profile or root receipt.
        source = ("import json,sys\nclass Refused(RuntimeError): pass\ncalls=[]\n"
            "def require(condition,message):\n    calls.append((condition,message))\n    if not condition: raise Refused(message)\n"
            "def main():\n" + body).encode()
        sources = self.observer_sources()
        sources['controller'] = source
        catalog = F.observer_catalog(sources)
        controller = types.ModuleType('source_observer_model')
        controller.__file__ = F.OBSERVER_PATHS['controller']
        controller.private = '/private/TOKEN=fictional-sensitive-value'
        controller.proof = {'kind': 'ADMISSION_CHECKONLY', 'installationAvailable': False, 'releaseEligible': False,
            'rootBoundaryInspected': True, 'typedEmptyCredentialsVerified': True, 'immutableEntriesInspected': 42,
            'remainingInstallationGates': ['authenticated-format3-grant-and-shared-lease',
                'complete-nginx-runtime-and-include-inventory', 'resource-envelope-admission',
                'old-new-build-and-server-action-compatibility', 'real-next-transport-and-worker-qualification']}
        exec(catalog['controller']['module'], controller.__dict__)
        return controller, catalog

    def test_source_observer_calls_actual_unmodified_controller_root_guard_without_root_or_systemd(self):
        self.assertNotEqual(os.geteuid(), 0)
        catalog = F.observer_catalog(self.observer_sources())
        controller = types.ModuleType('real_unprivileged_controller_source_model')
        controller.__file__ = F.OBSERVER_PATHS['controller']
        exec(catalog['controller']['module'], controller.__dict__)
        original, argv = controller.require, sys.argv
        with patch.object(controller, 'Profile') as profile, patch.object(controller.subprocess, 'run') as run:
            code, stdout, diagnostic = F.observe_controller_main(controller, catalog)
            profile.assert_not_called()
            run.assert_not_called()
        self.assertEqual((code, stdout, diagnostic), (1, '', {'classification': 'guard', 'owner': 'controller', 'line': 1106}))
        self.assertIs(controller.require, original)
        self.assertIs(sys.argv, argv)
        self.assertNotIn('The installed admission controller requires Linux root', F.CONFIGURATION_REASONS)

    def test_source_observer_calls_original_for_unmapped_private_require_and_restores_before_return(self):
        controller, catalog = self.observer_model("    try:\n        require(False,private)\n    except Refused as error:\n        print('Admission refused: '+str(error),file=sys.stderr)\n        return 1\n")
        original, argv = controller.require, sys.argv
        code, stdout, diagnostic = F.observe_controller_main(controller, catalog)
        self.assertEqual(code, 1)
        self.assertEqual(stdout, '')
        self.assertEqual(controller.calls, [(False, controller.private)])
        self.assertEqual(diagnostic, {'classification': 'guard', 'owner': 'controller', 'line': 9})
        self.assertNotIn('private', json.dumps(diagnostic))
        self.assertIs(controller.require, original)
        self.assertIs(sys.argv, argv)

    def test_source_observer_restores_on_success_direct_refusal_and_nonrequire_private_exception(self):
        for body, expected in [
            ("    require(True,private)\n    print(json.dumps(proof,sort_keys=True))\n    return 0\n", None),
            ("    require(True,private)\n    raise TypeError(private)\n", {'classification': 'cli-exception', 'exception': 'TypeError'}),
            ("    require(True,private)\n    raise Refused(private)\n", {'classification': 'cli-refusal'})]:
            controller, catalog = self.observer_model(body)
            original, argv = controller.require, sys.argv
            code, stdout, diagnostic = F.observe_controller_main(controller, catalog)
            self.assertEqual(controller.calls, [(True, controller.private)])
            self.assertIs(controller.require, original)
            self.assertIs(sys.argv, argv)
            self.assertEqual(diagnostic, expected)
            self.assertEqual(code, 0 if expected is None else 1)
            if expected is None:
                self.assertEqual(json.loads(stdout), controller.proof)
            else:
                self.assertEqual(stdout, '')
                self.assertNotIn('private', json.dumps(diagnostic))

    def test_source_observer_checks_real_next_and_inventory_guard_code_identities_with_private_inputs(self):
        for owner in ('next-profile', 'inventory'):
            controller, catalog = self.observer_model("    try:\n        callback()\n    except Refused as error:\n        print('Admission refused: '+str(error),file=sys.stderr)\n        return 1\n")
            module = types.ModuleType('model_' + owner.replace('-', '_'))
            module.__file__ = F.OBSERVER_PATHS[owner]
            # Fresh compilation, matching the production dynamic loader rather
            # than reusing the catalog's original code-object identities.
            exec(compile(self.observer_sources()[owner], str(pathlib.Path(F.OBSERVER_PATHS[owner])), 'exec', dont_inherit=True), module.__dict__)
            if owner == 'next-profile':
                controller.callback = lambda: module.relative('/private/TOKEN=fictional', controller.require)
            else:
                controller.callback = lambda: module.regular_metadata(types.SimpleNamespace(st_mode=0, st_size=1),
                    16, '/private/TOKEN=fictional', 'private', check=controller.require)
            original = controller.require
            code, stdout, diagnostic = F.observe_controller_main(controller, catalog)
            self.assertEqual((code, stdout), (1, ''))
            self.assertEqual(diagnostic['classification'], 'guard')
            self.assertEqual(diagnostic['owner'], owner)
            self.assertIn(diagnostic['line'], (58, 59, 60, 61) if owner == 'next-profile' else (41,))
            self.assertIs(controller.require, original)
            self.assertNotIn('TOKEN=', json.dumps(diagnostic))

    def test_source_observer_rejects_foreign_stack_forged_filename_code_and_foreign_main_identity(self):
        for filename in ('/private/TOKEN=fictional.py', F.OBSERVER_PATHS['controller']):
            controller, catalog = self.observer_model("    require(True,private)\n    try:\n        foreign()\n    except Refused as error:\n        print('Admission refused: '+str(error),file=sys.stderr)\n        return 1\n")
            # Place the forged call on the same admitted line; its code identity
            # must still refuse even when filename/globalfile/line all match.
            foreign = {'__file__': filename, 'controller': controller, 'private': controller.private}
            exec(compile('\n' * 6 + 'def foreign():\n    controller.require(False,private)\n', filename, 'exec'), foreign)
            controller.foreign = foreign['foreign']
            code, stdout, diagnostic = F.observe_controller_main(controller, catalog)
            self.assertEqual((code, stdout, diagnostic), (1, '', {'classification': 'foreign-guard'}))
            self.assertEqual(controller.calls, [(True, controller.private), (False, controller.private)])
            self.assertNotIn('TOKEN=', json.dumps(diagnostic))
        controller, catalog = self.observer_model('    return 1\n')
        original, argv = controller.require, sys.argv
        exec(compile('def replacement():\n    raise RuntimeError(private)\n', F.OBSERVER_PATHS['controller'], 'exec'), controller.__dict__)
        controller.main = controller.replacement
        with self.assertRaisesRegex(AssertionError, '^Observer controller code identity differs$'):
            F.observe_controller_main(controller, catalog)
        self.assertEqual(controller.calls, [])
        self.assertIs(controller.require, original)
        self.assertIs(sys.argv, argv)

    def observer_binding(self):
        sources = self.observer_sources()
        sha = lambda value: hashlib.sha256(value).hexdigest()
        profile = {'version': 2, 'controllerDigest': sha(sources['controller']), 'trustedModules': {
            'next_profile.py': sha(sources['next-profile']), 'runtime_inventory.py': sha(sources['inventory'])}}
        profile_raw = (json.dumps(profile, sort_keys=True) + '\n').encode()
        own = pathlib.Path(F.__file__).read_bytes()
        expected = {'version': 1, 'kind': 'SOURCE_BOUND_INSTALLED_CHECKONLY_OBSERVER', 'observerSha256': sha(own),
            'profileSha256': sha(profile_raw), 'sourceHashes': {key: sha(raw) for key, raw in sources.items()}}
        return expected, own, sources, profile_raw

    def test_source_observer_binds_all_three_sources_own_bytes_and_profile_before_any_code_can_execute(self):
        expected, own, sources, profile = self.observer_binding()
        canonical = (json.dumps(expected, sort_keys=True, separators=(',', ':')) + '\n').encode()
        self.assertEqual(F.observer_input(canonical), expected)
        self.assertEqual(set(F.observer_bind(expected, own, sources, profile)), set(F.OBSERVER_PATHS))
        for owner in F.OBSERVER_PATHS:
            changed = sources | {owner: sources[owner] + b'private TOKEN=fictional'}
            with patch.object(F, 'observer_catalog') as compile_sources, self.assertRaises(AssertionError):
                F.observer_bind(expected, own, changed, profile)
            compile_sources.assert_not_called()
        for own_value, profile_value in [(own + b'private', profile), (own, profile + b'private')]:
            with patch.object(F, 'observer_catalog') as compile_sources, self.assertRaises(AssertionError):
                F.observer_bind(expected, own_value, sources, profile_value)
            compile_sources.assert_not_called()
        bad = expected | {'sourceHashes': expected['sourceHashes'] | {'foreign': 'a' * 64}}
        for raw in [(json.dumps(bad) + '\n').encode(), canonical + b'private', b'private TOKEN=fictional', b'x' * 4097]:
            with self.assertRaises(AssertionError):
                F.observer_input(raw)

    def test_source_observer_decoder_requires_bound_callsite_and_never_reflects_unknown_private_or_extra_fields(self):
        catalog = F.observer_catalog(self.observer_sources())
        encode = lambda value: (json.dumps({'version': 1, 'kind': 'SOURCE_BOUND_CHECKONLY_REFUSAL', **value}, sort_keys=True) + '\n').encode()
        self.assertEqual(F.observer_diagnostic(encode({'classification': 'guard', 'owner': 'controller', 'line': 1106}), catalog),
            {'reason': 'controller-source-guard', 'sourceGuard': {'owner': 'controller', 'line': 1106}})
        for value in [{'classification': 'guard', 'owner': '/private/TOKEN=fictional', 'line': 1106},
                      {'classification': 'guard', 'owner': 'controller', 'line': True},
                      {'classification': 'guard', 'owner': 'controller', 'line': 1},
                      {'classification': 'guard', 'owner': 'controller', 'line': 1106, 'private': 'TOKEN=fictional'},
                      {'classification': 'cli-exception', 'exception': 'private TOKEN=fictional'}]:
            self.assertEqual(F.observer_diagnostic(encode(value), catalog), {'reason': 'controller-observer-refused'})
        for raw in (b'private TOKEN=fictional', b'private' * 10000, None):
            self.assertEqual(F.observer_diagnostic(raw, catalog), {'reason': 'controller-observer-refused'})
        self.assertEqual(F.observer_diagnostic(encode({'classification': 'foreign-guard'}), catalog), {'reason': 'controller-foreign-guard'})
        for stage in F.OBSERVER_BINDING_STAGES:
            self.assertEqual(F.observer_diagnostic(encode({'classification': 'binding-refusal', 'stage': stage}), {}),
                {'reason': 'controller-observer-binding', 'bindingStage': stage})
        self.assertEqual(F.observer_diagnostic(encode({'classification': 'binding-refusal', 'stage': '/private/TOKEN=fictional'}), {}),
            {'reason': 'controller-observer-refused'})
        self.assertEqual(F.observer_diagnostic(encode({'classification': 'cli-exception', 'exception': 'TypeError'}), catalog),
            {'reason': 'controller-exception', 'exception': 'TypeError'})

    def test_source_observer_launch_uses_only_fixed_checkonly_closed_stdin_and_original_timeout(self):
        expected, _own, _sources, _profile = self.observer_binding()
        result = types.SimpleNamespace(returncode=1, stdout=b'', stderr=b'private TOKEN=fictional')
        with patch.object(F, 'run', return_value=result) as run:
            self.assertIs(F.control('check-only', check=False, observer=expected), result)
            self.assertEqual(run.call_args.args[0], ['/usr/bin/python3', '-I', '-B', str(pathlib.Path(F.__file__).absolute()), '--observe-check-only'])
            self.assertEqual(run.call_args.kwargs, {'input': (json.dumps(expected, sort_keys=True, separators=(',', ':')) + '\n').encode(), 'check': False, 'timeout': 60})
        for operation, unit in [('initialize', None), ('status', None), ('check-only', F.UNITS[0])]:
            with patch.object(F, 'run') as run, self.assertRaises(AssertionError):
                F.control(operation, unit=unit, check=False, observer=expected)
            run.assert_not_called()

    def test_source_observer_keeps_abnormal_numeric_exit_closed_and_actual_root_entry_refuses_nonroot(self):
        expected, _own, _sources, _profile = self.observer_binding()
        F.report = {'currentPhase': 'protected-native-configuration'}
        F.configuration_phase('check-only')
        with patch.object(F, 'control', return_value=types.SimpleNamespace(returncode=-9, stderr=b'private TOKEN=fictional')) as control, \
             patch.object(F, 'observer_bound_catalog') as catalog, self.assertRaises(AssertionError):
            F.configuration_control('check-only', observer=expected)
        control.assert_called_once_with('check-only', check=False, observer=expected)
        catalog.assert_not_called()
        self.assertEqual(F.report['configuration']['exit'], {'classification': 'signal', 'status': -9})
        self.assertEqual(F.report['configuration']['reason'], 'controller-signal')
        self.assertNotIn('private', json.dumps(F.report))
        self.assertNotEqual(os.geteuid(), 0)
        with patch.object(F, 'observer_read') as read, self.assertRaisesRegex(AssertionError, '^Observer requires owned Linux root$'):
            F.observer_entry()
        read.assert_not_called()

    def test_source_observer_output_buffer_is_bounded_in_bytes_and_private_success_is_never_forwarded(self):
        stream = F.ObserverStream(8)
        self.assertEqual(stream.write('漢字'), 2)
        self.assertEqual(stream.length, 6)
        stream.write('漢')
        self.assertTrue(stream.overflow)
        self.assertEqual(stream.parts, [])
        self.assertEqual(stream.text(), '')
        controller, catalog = self.observer_model("    print(private)\n    return 0\n")
        original, argv = controller.require, sys.argv
        with self.assertRaises((ValueError, AssertionError)):
            F.observe_controller_main(controller, catalog)
        self.assertIs(controller.require, original)
        self.assertIs(sys.argv, argv)


if __name__ == '__main__':
    unittest.main()
