"""Stdlib source models only: never root, systemd, a Next process or a build witness."""
import copy
import importlib.util
import json
import pathlib
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

    def test_actual_directory_function_keeps_slice_refusal_and_identifies_its_fixed_guard(self):
        with patch.object(F.os.path, 'lexists', return_value=False), \
             patch.object(F, 'props', side_effect=lambda unit: {'LoadState': 'loaded' if unit == F.SLICE else 'not-found'}), \
             patch.object(F.os, 'mkdir') as mkdir:
            with self.assertRaisesRegex(AssertionError, '^Closed native prepackage guard refused$'):
                F.fixture_directories()
            mkdir.assert_not_called()
        self.assertEqual(F.report['prepackageGuardFailure'], {'stage': 'unit-absence', 'code': 'fixture-unit-3'})
        self.assertNotIn('fictional-sensitive-value', json.dumps(self.saved))


if __name__ == '__main__':
    unittest.main()
