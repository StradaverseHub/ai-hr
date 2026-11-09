"""Pure source models only. Hosted native service/journal custody is separate evidence."""
import ast
import base64
import copy
import hashlib
import json
import pathlib
import sys
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import test_next_environment_observation as old
N, P, F = old.N, old.P, old.F


def _fresh_parent_bytes(path):
    """Runtime inverse data only; immutable Git provenance is checked externally."""
    inverse=json.loads((ROOT/'deploy/admission/next_controller_admit_timing_inverse.json').read_text())
    row=inverse['files'][path];current=(ROOT/path).read_text()
    assert hashlib.sha256(current.encode()).hexdigest()==row['currentSha256']
    lines=current.splitlines(keepends=True)
    for edit in row['changes']:
        assert ''.join(lines[edit['start']:edit['end']])==edit['after']
        lines[edit['start']:edit['end']]=edit['before'].splitlines(keepends=True)
    parent=''.join(lines).encode();assert hashlib.sha256(parent).hexdigest()==row['originalSha256']
    return parent


class PlainKeyNameModels(unittest.TestCase):
    def keys(self, count=1):
        return tuple('FICTIONAL_OTHER_' + str(index) for index in range(count))

    def digest(self, names=None):
        names = self.keys() if names is None else names
        return N.key_name_digests(names, len(names))

    def plain(self, names=None):
        names = self.keys() if names is None else names
        return N.plain_key_names(names, len(names), self.digest(names))

    def terminal(self, names=None, plain=None):
        names = self.keys() if names is None else names
        return {'version': 3, 'kind': 'CLOSED_PHASE_TERMINAL_OTHER_KEY_NAMES_NOT_ADMISSION',
            'phase': old.PhaseDiagnosticModels().packet(P.PHASES[-1], 'finished'),
            'keyNames': self.digest(names), **(self.plain(names) if plain is None else plain)}

    def journal(self, terminal=None, names=None, with_environment=True, changes=None):
        names = self.keys() if names is None else names
        base, phases = old.EnvironmentObservationModels(), old.PhaseDiagnosticModels()
        value = base.observe(environment_values={'INVOCATION_ID': 'a'*32} | dict.fromkeys(names, 'FICTIONAL_PRIVATE_VALUE'))[0]
        rows = base.journal(value) if with_environment else b''
        rows += b''.join(phases.journal(phases.packet(name)) for name in P.PHASES)
        return rows + base.journal(message=P.PLAIN_TERMINAL_PREFIX + json.dumps(self.terminal(names) if terminal is None else terminal), changes=changes)

    def receive(self, journal):
        return old.PhaseDiagnosticModels().receive(journal)

    def test_complete_zero_one_four_are_explicit_sorted_names_with_old_digest_pairing(self):
        for count in (0, 1, 4):
            names = self.keys(count)
            digest = self.digest(names)
            actual = N.plain_key_names(tuple(reversed(names)) + ('NODE_ENV', 'LANGUAGE', 'INVOCATION_ID'), count, digest)
            self.assertEqual(actual, {'namesComplete': True, 'names': sorted(names)})
            self.assertIs(N.validate_plain_key_names(actual, digest), actual)
            self.assertEqual(sorted(hashlib.sha256(N.KEY_NAME_DIGEST_DOMAIN + name.encode()).hexdigest() for name in actual['names']), digest['digests'])

    def test_ascii_standard_grammar_accepts_one_and_exact64_without_escaping(self):
        for names in (('A', '_A', 'a0'), tuple(chr(65 + i) + '0'*63 for i in range(4))):
            result = self.plain(names)
            self.assertTrue(result['namesComplete']);self.assertEqual(result['names'], sorted(names))
            self.assertNotIn('\\', json.dumps(result))

    def test65_unicode_whitespace_punctuation_and_escaped_names_are_all_or_nothing(self):
        for name in ('A'*65, '鍵', '😀', 'A B', 'A\nB', 'A\rB', 'A\\B', 'A"B', '1A', 'A-B', '.A'):
            names = ('VALID_PUBLIC_OTHER', name)
            self.assertEqual(self.plain(names), {'namesComplete': False, 'names': []})

    def test_forbidden_other_name_suppresses_entire_plain_set_without_losing_old_hashes(self):
        for name in ('GH_TOKEN', 'GITHUB_TOKEN', 'NODE_OPTIONS', 'MIGRATION_DATABASE_URL', 'LD_PRELOAD', 'PYTHONPATH'):
            names = ('VALID_PUBLIC_OTHER', name)
            digest = self.digest(names)
            self.assertEqual(digest['state'], 'complete')
            self.assertEqual(N.plain_key_names(names, 2, digest), {'namesComplete': False, 'names': []})
            with self.assertRaises(ValueError):N.validate_plain_key_names({'namesComplete': True, 'names': sorted(names)}, digest)

    def test_allowed_private_and_fixed_vocabulary_names_never_enter_plain_payload(self):
        private = tuple(sorted(N.APP_ENVIRONMENT | N.FLEET_ENVIRONMENT | N.SYSTEMD_ENVIRONMENT | set(N.ENVIRONMENT_OBSERVATION_NAMES)))
        keys = private + self.keys()
        result = N.plain_key_names(keys, 1, N.key_name_digests(keys, 1))
        self.assertEqual(result, {'namesComplete': True, 'names': list(self.keys())})
        for name in private:self.assertNotIn(name, result['names'])
        for name in ('DATABASE_URL', 'AUTH_SESSION_KEY', 'AI_CONFIG_SECRET', 'LANGUAGE'):
            forged = {'version': 1, 'kind': N.KEY_NAME_DIGEST_KIND, 'state': 'complete', 'count': 1,
                'digests': [hashlib.sha256(N.KEY_NAME_DIGEST_DOMAIN + name.encode()).hexdigest()], 'reason': 'none'}
            with self.assertRaises(ValueError):N.validate_plain_key_names({'namesComplete': True, 'names': [name]}, forged)

    def test_overflow_five_or_unavailable_original_digest_never_leaks_a_prefix(self):
        self.assertEqual(self.plain(self.keys(5)), {'namesComplete': False, 'names': []})
        for digest in (N.unavailable_key_name_digests(1), N.unavailable_key_name_digests(5)):
            self.assertEqual(N.plain_key_names(self.keys(digest['count']), digest['count'], digest), {'namesComplete': False, 'names': []})

    def test_mapping_views_lists_and_duplicate_tuple_cannot_smuggle_value_capability(self):
        digest = self.digest()
        private = {self.keys()[0]: 'FICTIONAL_PRIVATE_VALUE'}
        for keys in (private, private.keys(), list(private), iter(private)):
            with self.assertRaises(ValueError):N.plain_key_names(keys, 1, digest)
        for keys in ((self.keys()[0], self.keys()[0]), ('',), ('A=B',), ('A\0B',), (1,)):
            self.assertEqual(N.plain_key_names(keys, 1, digest), {'namesComplete': False, 'names': []})

    def test_wrong_hash_domain_or_count_suppresses_producer_and_refuses_complete_receiver(self):
        for digest in (self.digest() | {'digests': ['a'*64]}, self.digest() | {'digests': [hashlib.sha256(self.keys()[0].encode()).hexdigest()]}, self.digest(self.keys(2))):
            if digest['count'] == 1:self.assertEqual(N.plain_key_names(self.keys(), 1, digest), {'namesComplete': False, 'names': []})
            with self.assertRaises(ValueError):N.validate_plain_key_names({'namesComplete': True, 'names': list(self.keys())}, digest)
        with self.assertRaises(ValueError):N.plain_key_names(self.keys(), 0, self.digest())

    def test_closed_plain_codec_rejects_extra_fields_wrong_types_duplicates_unsorted_or_partial(self):
        good = self.plain(self.keys(2));digest = self.digest(self.keys(2))
        for value in (good | {'namesComplete': 1}, good | {'names': tuple(good['names'])}, good | {'rawValue': 'PRIVATE'},
                good | {'names': good['names'][::-1]}, good | {'names': [good['names'][0]]*2},
                good | {'namesComplete': False}, good | {'names': good['names'][:1]}, good | {'names': [1, 2]}):
            with self.assertRaises(ValueError):N.validate_plain_key_names(value, digest)
        self.assertEqual(N.validate_plain_key_names({'namesComplete': False, 'names': []}, digest), {'namesComplete': False, 'names': []})

    def test_native_same_read_tuple_seam_keeps_values_private_and_single_environ_read(self):
        captured, reads = [], []
        def capture(keys, count):
            self.assertIs(type(keys), tuple)
            digest = N.key_name_digests(keys, count)
            captured.append(N.plain_key_names(keys, count, digest))
        value, _ = old.EnvironmentObservationModels().observe(environment_values={'INVOCATION_ID': 'a'*32,
            'FICTIONAL_PUBLIC_OTHER': 'FICTIONAL_PRIVATE_VALUE', 'DATABASE_URL': 'PRIVATE_DB_URL'}, key_names=capture, read_calls=reads)
        self.assertEqual(reads.count('environ'), 1);self.assertEqual(captured, [{'namesComplete': True, 'names': ['FICTIONAL_PUBLIC_OTHER']}])
        self.assertFalse(value['nextApplicationVerified'] or value['releaseEligible'])
        self.assertNotIn('PRIVATE', json.dumps(captured));self.assertNotIn('DATABASE_URL', json.dumps(captured))

    def test_source_bound_pure_codec_has_no_environment_or_value_access(self):
        source = (ROOT/'deploy/admission/next_profile.py').read_text();tree = ast.parse(source)
        for name in ('plain_key_names', 'validate_plain_key_names'):
            fn = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == name)
            text = ast.get_source_segment(source, fn)
            for forbidden in ('os.environ', 'environment_process_read', 'getenvironment', '.values(', '.mapping', 'subprocess'):
                self.assertNotIn(forbidden, text)
        self.assertEqual(N.PLAIN_KEY_NAME_MAX, 64)

    def test_v3_tracker_worst_case998_and_unchanged15_message_aggregate7693(self):
        names = tuple(chr(65 + i) + 'X'*63 for i in range(4));messages = []
        with patch.object(P.time, 'monotonic', return_value=1), patch.object(P.os, 'write', side_effect=lambda _fd, b: messages.append(b) or len(b)):
            tracker = P.PhaseTracker(F.UNITS[1], 2)
            for phase in P.PHASES:tracker.enter(phase)
            tracker.capture_keys(self.digest(names), N.validate_key_name_digests, self.plain(names), N.validate_plain_key_names)
            tracker.finish()
        self.assertEqual(len(messages), 14);self.assertEqual(len(messages[-1]), 998)
        self.assertEqual(sum(map(len, messages[:-1])), 2599);self.assertEqual(sum(map(len, messages)) + 4096, 7693)
        self.assertLessEqual(max(map(len, messages)), 1024);self.assertLessEqual(sum(map(len, messages)) + 4096, 18432)
        self.assertTrue(messages[-1].startswith(P.PLAIN_TERMINAL_PREFIX.encode()));self.assertTrue(messages[-1].endswith(b'\n'))

    def test_closed_v3_validator_requires_original_finished_phase_and_digest_pairing(self):
        good = self.terminal()
        self.assertIs(P.validate_plain_terminal_observation(good, 'worker-1', N.validate_key_name_digests, N.validate_plain_key_names), good)
        for change in ({'version': True}, {'version': 2}, {'kind': 'PRIVATE'}, {'rawName': 'PRIVATE'},
                {'phase': old.PhaseDiagnosticModels().packet()}, {'namesComplete': True, 'names': ['FOREIGN_OTHER']},
                {'namesComplete': False, 'names': list(self.keys())}):
            with self.assertRaises(ValueError):P.validate_plain_terminal_observation(good | change, 'worker-1', N.validate_key_name_digests, N.validate_plain_key_names)

    def test_full14_phase_same_v1_receiver_publishes_names_as_diagnostic_only(self):
        result = self.receive(self.journal())
        diag = result['diagnostic'];plain = diag['plainKeyNameDiagnostic']
        self.assertEqual(len(diag['phases']), 14);self.assertFalse(diag['phaseUnavailable'])
        self.assertEqual(plain, {'kind': 'PLAIN_OTHER_KEY_NAMES_NOT_ENVIRONMENT_OR_ADMISSION', 'state': 'complete',
            'helperCompletion': 'finished', 'count': 1, 'names': list(self.keys()), 'reason': 'none'})
        self.assertEqual(diag['keyNameDiagnostic']['digests'], self.digest()['digests'])
        self.assertEqual(len(result['observations']), 1);self.assertFalse(result['observations'][0]['nextApplicationVerified'])
        self.assertNotIn('FICTIONAL_PRIVATE_VALUE', json.dumps(result))

    def test_unavailable_plain_preserves_genuine_v1_and_digest_success(self):
        result = self.receive(self.journal(self.terminal(plain={'namesComplete': False, 'names': []})))
        self.assertEqual(len(result['observations']), 1);self.assertEqual(result['diagnostic']['keyNameDiagnostic']['state'], 'complete')
        plain = result['diagnostic']['plainKeyNameDiagnostic']
        self.assertEqual(plain['state'], 'unavailable');self.assertEqual(plain['reason'], 'plain-unavailable');self.assertEqual(plain['names'], [])

    def test_missing_v1_cannot_turn_a_genuine_v3_phase_ledger_into_publication(self):
        result = self.receive(self.journal(with_environment=False));plain = result['diagnostic']['plainKeyNameDiagnostic']
        self.assertEqual(plain['names'], []);self.assertEqual(plain['reason'], 'environment-observation-missing')
        self.assertIsNone(plain['count']);self.assertEqual(result['observations'], [])

    def test_old_v2_packets_retain_hash_diagnostic_without_plain_name_publication(self):
        result = self.receive(old.KeyNameDigestModels().journal())
        self.assertEqual(result['diagnostic']['keyNameDiagnostic']['state'], 'complete')
        self.assertEqual(result['diagnostic']['plainKeyNameDiagnostic']['names'], [])
        self.assertEqual(result['diagnostic']['plainKeyNameDiagnostic']['reason'], 'terminal-v3-absent')

    def test_partial_phase_ledger_or_lone_terminal_cannot_publish_plain_names(self):
        rows = self.journal().splitlines(keepends=True)
        for raw in (b''.join(rows[:-1]), rows[0] + rows[-1], rows[-1]):
            result = self.receive(raw);self.assertEqual(result['diagnostic']['plainKeyNameDiagnostic']['names'], [])
            self.assertNotEqual(result['diagnostic']['plainKeyNameDiagnostic']['state'], 'complete')

    def test_foreign_native_metadata_and_helper_command_cannot_publish(self):
        for changes in ({'_UID': '65534'}, {'_EXE': '/foreign'}, {'_SYSTEMD_UNIT': F.UNITS[1]},
                {'_SYSTEMD_INVOCATION_ID': 'b'*32}, {'_CMDLINE': '/usr/bin/python3 -I -B /usr/local/lib/aihr-admission/controller.py admit ' + F.UNITS[0]}):
            result = self.receive(self.journal(changes=changes))
            self.assertEqual(len(result['observations']), 1)
            self.assertEqual(result['diagnostic']['plainKeyNameDiagnostic']['names'], [])

    def test_duplicate_malformed_or_count_mismatched_v3_keeps_old_v1_but_not_names(self):
        good = self.terminal();rows = self.journal().splitlines(keepends=True)
        for terminal in (good | {'names': ['FOREIGN_OTHER']}, good | {'version': True}, good | {'keyNames': self.digest(self.keys(2))},
                good | {'phase': good['phase'] | {'subject': 'worker-2'}}, good | {'namesComplete': False}):
            result = self.receive(self.journal(terminal));self.assertEqual(len(result['observations']), 1)
            self.assertEqual(result['diagnostic']['plainKeyNameDiagnostic']['names'], [])
            self.assertTrue(result['diagnostic']['phaseUnavailable'])
        for raw in (self.journal() + rows[-1], b''.join(rows[:-1]) + old.EnvironmentObservationModels().journal(
                message=P.PLAIN_TERMINAL_PREFIX + json.dumps(good).replace('"version": 3', '"version": 3, "version": 3', 1))):
            result = self.receive(raw);self.assertEqual(len(result['observations']), 1)
            self.assertEqual(result['diagnostic']['plainKeyNameDiagnostic']['names'], []);self.assertTrue(result['diagnostic']['phaseUnavailable'])

    def test_v3_unknown_prefix_is_not_a_terminal_or_fallback_name_oracle(self):
        rows = self.journal().splitlines(keepends=True)
        last = json.loads(rows[-1]);last['MESSAGE'] = last['MESSAGE'].replace(P.PLAIN_TERMINAL_PREFIX, 'AIHR_UNKNOWN_TERMINAL ', 1)
        result = self.receive(b''.join(rows[:-1]) + (json.dumps(last) + '\n').encode())
        self.assertEqual(result['diagnostic']['plainKeyNameDiagnostic']['names'], [])
        self.assertEqual(result['diagnostic']['plainKeyNameDiagnostic']['reason'], 'helper-not-finished')

    def test_v3_uncertain_write_never_retries_or_publishes_failure_with_names(self):
        for outcome in (1, OSError('FICTIONAL_PRIVATE_ERROR')):
            with patch.object(P.time, 'monotonic', return_value=1), patch.object(P.os, 'write', side_effect=lambda _fd, b: len(b)):
                tracker = P.PhaseTracker(F.UNITS[0], 2)
                for phase in P.PHASES:tracker.enter(phase)
                tracker.capture_keys(self.digest(), N.validate_key_name_digests, self.plain(), N.validate_plain_key_names)
            with patch.object(P.time, 'monotonic', return_value=1), patch.object(P.os, 'write', side_effect=outcome if isinstance(outcome, BaseException) else lambda _fd, _b: outcome) as writing:
                with self.assertRaises(OSError):tracker.finish()
                tracker.fail(KeyboardInterrupt('FICTIONAL_PRIVATE_ERROR'));self.assertEqual(writing.call_count, 1)
                self.assertTrue(tracker.terminal and tracker.broken)

    def test_v3_post_try_abort_latches_before_publish_and_cannot_emit_second_terminal(self):
        source = (ROOT/'deploy/admission/next_fixture_poststart.py').read_text();tree = ast.parse(source)
        owner = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'PhaseTracker')
        write = next(n for n in owner.body if isinstance(n, ast.FunctionDef) and n.name == 'write')
        native_try = next(n for n in write.body if isinstance(n, ast.Try));boundary = next(n.lineno for n in write.body if n.lineno > native_try.end_lineno)
        records, state = [], {'written': False, 'aborted': False};code = P.PhaseTracker.write.__code__
        def output(_fd, message):
            records.append(message)
            if message.startswith(P.PLAIN_TERMINAL_PREFIX.encode()):state['written'] = True
            return len(message)
        def trace(frame, event, _arg):
            if frame.f_code is code and event == 'line' and frame.f_lineno == boundary and state['written'] and not state['aborted']:
                state['aborted'] = True;raise KeyboardInterrupt('FICTIONAL_PRIVATE_ERROR')
            return trace
        with patch.object(P.time, 'monotonic', return_value=1), patch.object(P.os, 'write', side_effect=output):
            tracker = P.PhaseTracker(F.UNITS[0], 2)
            for phase in P.PHASES:tracker.enter(phase)
            tracker.capture_keys(self.digest(), N.validate_key_name_digests, self.plain(), N.validate_plain_key_names);previous = sys.gettrace()
            try:
                sys.settrace(trace)
                with self.assertRaises(KeyboardInterrupt):tracker.finish()
            finally:sys.settrace(previous)
            tracker.fail(KeyboardInterrupt())
        self.assertTrue(state['aborted']);self.assertEqual(len(records), 14)
        self.assertEqual(sum(message.startswith(P.PLAIN_TERMINAL_PREFIX.encode()) for message in records), 1)

    def test_composed_receipt_replays_every_byte_and_preserves_all_frozen_parent_preimages(self):
        inverse = json.loads((ROOT/'deploy/admission/next_plain_key_names_inverse.json').read_text())
        name = 'deploy/admission/next_host_key_receipt_inverse.json'
        row = inverse['files'][name];parent_bytes = base64.b64decode(row['originalBase64'])
        self.assertEqual(hashlib.sha256(parent_bytes).hexdigest(), row['originalSha256'])
        before = json.loads(parent_bytes);current = json.loads((ROOT/name).read_text())
        self.assertEqual(current['base'], before['base']);self.assertFalse(current['composition']['historicalRunEvidenceTransferred'])
        self.assertEqual(current['composition']['wholeParentReceiptSha256'], row['originalSha256'])
        wrapper = 'test/runtime-next-environment-observation.test.ts'
        provenance = json.loads((ROOT/'docs/qualification/native-next-fresh-child-parent-source-20261109.json').read_text())
        binding = provenance['pureControlFailureRepairParent']['newWrapperC045WholePreimage']
        expected_binding = {
            'inverse': 'next_host_key_receipt_inverse.json', 'path': wrapper,
            'commit': 'c0456f6a98e5f3feaf11ca4d759d57c8b76e25da',
            'gitBlob': 'd6506ee5d302d1ef81eea040f9295376e9e60670', 'bytes': 838,
            'sha256': 'e57287d83cee40072b199f02c8bfce14ed82c2db445cbe3ffe2439a3dc585509',
        }
        def adjudicate(file, recipe, wrapper_binding):
            if file in before['files']:
                self.assertEqual(recipe['originalBase64'], before['files'][file]['originalBase64'])
                self.assertEqual(recipe['originalSha256'], before['files'][file]['originalSha256'])
            elif file in inverse['files']:
                self.assertEqual(recipe['originalBase64'], inverse['files'][file]['originalBase64'])
                self.assertEqual(recipe['originalSha256'], inverse['files'][file]['originalSha256'])
            elif file == wrapper:
                self.assertEqual(wrapper_binding, expected_binding)
                self.assertEqual(recipe['originalSha256'], wrapper_binding['sha256'])
                original = base64.b64decode(recipe['originalBase64'], validate=True)
                self.assertEqual(len(original), wrapper_binding['bytes'])
                self.assertEqual(hashlib.sha256(original).hexdigest(), wrapper_binding['sha256'])
            else:
                self.fail('Unknown receipt preimage family')
        self.assertIn(wrapper, current['files'])
        for file, recipe in current['files'].items():
            source = (ROOT/file).read_text();self.assertEqual(hashlib.sha256(source.encode()).hexdigest(), recipe['currentSha256'])
            lines = source.splitlines(keepends=True);frontier = len(lines)
            for change in recipe['changes']:
                self.assertTrue(0 <= change['start'] <= change['end'] <= frontier)
                self.assertEqual(''.join(lines[change['start']:change['end']]), change['after'])
                lines[change['start']:change['end']] = change['before'].splitlines(keepends=True);frontier = change['start']
            restored = ''.join(lines).encode();self.assertEqual(restored, base64.b64decode(recipe['originalBase64']))
            self.assertEqual(hashlib.sha256(restored).hexdigest(), recipe['originalSha256'])
            adjudicate(file, recipe, binding)
        # Exercise the SAME positive adjudicator, never a permissive fallback or
        # a source-string/count proxy. No new runtime/Git authority is introduced.
        recipe = current['files'][wrapper]
        with self.assertRaisesRegex(AssertionError, '^Unknown receipt preimage family$'):
            adjudicate('test/foreign-receipt-preimage.test.ts', recipe, binding)
        for key, value in expected_binding.items():
            changed = {**binding, key: value + 1 if type(value) is int else value + '-foreign'}
            with self.assertRaises(AssertionError):adjudicate(wrapper, recipe, changed)
        with self.assertRaises(AssertionError):
            adjudicate(wrapper, {**recipe, 'originalSha256': '0' * 64}, binding)
        with self.assertRaises(ValueError):
            adjudicate(wrapper, {**recipe, 'originalBase64': '!'}, binding)
        payload = base64.b64decode(recipe['originalBase64'], validate=True)
        for changed in (payload[:-1], bytes([payload[0] ^ 1]) + payload[1:]):
            with self.assertRaises(AssertionError):
                adjudicate(wrapper, {**recipe, 'originalBase64': base64.b64encode(changed).decode()}, binding)

    def test_whole_original_guards_observer_v1_parser_v2_validator_exec_and37_models_are_preserved(self):
        inverse = json.loads((ROOT/'deploy/admission/next_plain_key_names_inverse.json').read_text())
        def original(file):
            row = inverse['files'][file];data = base64.b64decode(row['originalBase64'])
            self.assertEqual(hashlib.sha256(data).hexdigest(), row['originalSha256']);return data.decode()
        def nodes(source):
            return {n.name: ast.get_source_segment(source, n) for n in ast.parse(source).body if isinstance(n, ast.FunctionDef)}
        for file, names in [('deploy/admission/next_profile.py', ['forbidden_environment', 'environment_observation_values',
                'environment_observation_counts', 'validate_environment_observation', 'key_name_digests', 'observe_owned_environment']),
                ('deploy/admission/next_fixture_poststart.py', ['validate_phase_observation', 'validate_terminal_observation', 'main']),
                ('deploy/admission/test_next_native.py', ['runtime_environment_journal_observation', 'runtime_journal_observation'])]:
            before, after = nodes(original(file)), nodes(_fresh_parent_bytes(file).decode() if file=='deploy/admission/next_fixture_poststart.py' else (ROOT/file).read_text())
            for name in names:self.assertEqual(after[name], before[name])
        file = 'deploy/admission/next_profile.py'
        def method(source):
            cls = next(n for n in ast.parse(source).body if isinstance(n, ast.ClassDef) and n.name == 'NextRuntime')
            return ast.get_source_segment(source, next(n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == '_environment'))
        self.assertEqual(method(original(file)), method((ROOT/file).read_text()))
        row = inverse['unchanged37Models'];self.assertEqual(hashlib.sha256(_fresh_parent_bytes(row['path'])).hexdigest(), row['sha256'])


if __name__ == '__main__':
    unittest.main()
