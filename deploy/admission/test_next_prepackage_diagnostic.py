"""Stdlib source models only: never root, systemd, a Next process or a build witness."""
import copy
import contextlib
import importlib.util
import json
import os
import pathlib
import tempfile
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


if __name__ == '__main__':
    unittest.main()
