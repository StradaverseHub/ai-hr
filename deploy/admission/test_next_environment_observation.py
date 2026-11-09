"""Source models only; no native/root/systemd/app/DB or environment discovery."""
import ast
import base64
import copy
import hashlib
import json
import os
import pathlib
import signal
import sys
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[2]


def load(name, file):
    value = types.ModuleType(name)
    value.__file__ = str(file)
    exec(compile(file.read_bytes(), str(file), 'exec', dont_inherit=True), value.__dict__)
    return value


N = load('model_environment_owner', ROOT / 'deploy/admission/next_profile.py')
P = load('model_environment_hook', ROOT / 'deploy/admission/next_fixture_poststart.py')
F = load('model_environment_receiver', ROOT / 'deploy/admission/test_next_native.py')


def require(value, reason):
    if not value:
        raise AssertionError(reason)


def raw(values):
    return b''.join(key.encode() + b'=' + value.encode() + b'\0' for key, value in values.items())


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


class EnvironmentObservationModels(unittest.TestCase):
    def expected(self):
        return dict(pid=42, invocation='a'*32, uid=65534, executable='/owned/node', cwd='/owned/release',
            cgroup='/owned/worker', argv=['/owned/node', 'start'], title=None, subject='worker-1')

    def observe(self, *, uid=65534, invocation=None, field=None, second_ticks=None, custody=None, named_inode=2, phase=None, key_names=None, environment_values=None, read_calls=None):
        expected = self.expected()
        stat_calls = 0
        def read(_fd, name, _bound, _deadline):
            nonlocal stat_calls
            if read_calls is not None:
                read_calls.append(name)
            if name == 'stat':
                stat_calls += 1
                ticks = second_ticks if stat_calls == 2 and second_ticks is not None else b'1234'
                return b'42 (model comm) ' + b' '.join([b'S'] + [b'0']*18 + [ticks])
            if name == 'environ':
                return raw(environment_values if environment_values is not None else {'INVOCATION_ID': invocation or 'a'*32, 'LANGUAGE': 'fictional-private'})
            if field == name:
                return b'foreign\0' if name == 'cmdline' else b'0::/foreign\n'
            return b'/owned/node\0start\0' if name == 'cmdline' else b'0::/owned/worker\n'
        info = types.SimpleNamespace(st_uid=uid, st_dev=1, st_ino=2)
        calls = []
        def own():
            calls.append('custody')
            if custody is not None:
                custody(len(calls))
        with patch.object(N.os, 'open', return_value=100), patch.object(N.os, 'close'), \
                patch.object(N.os, 'fstat', return_value=info), patch.object(pathlib.Path, 'stat', return_value=types.SimpleNamespace(st_uid=uid, st_dev=1, st_ino=named_inode)), \
                patch.object(N.os, 'readlink', side_effect=lambda name, **_kw: '/foreign' if name == field else '/owned/node' if name == 'exe' else '/owned/release'), \
                patch.object(N, 'environment_process_read', side_effect=read):
            value = N.observe_owned_environment(expected, own, float('inf'), _phase=phase, _key_names=key_names)
        return value, calls

    def value(self):
        return self.observe()[0]

    def sources(self):
        sources = {'next-profile': (ROOT/'deploy/admission/next_profile.py').read_bytes(),
                   'poststart': (ROOT/'deploy/admission/next_fixture_poststart.py').read_bytes()}
        binding = {'helpers': {name: {'sha256': hashlib.sha256(sources[owner]).hexdigest()}
            for owner, name in [('next-profile', 'next_profile.py'), ('poststart', 'next_fixture_poststart.py')]}}
        return sources, binding

    def journal(self, value=None, changes=None, message=None):
        row = {'_UID': '0', '_EXE': '/usr/bin/python3.12', '_SYSTEMD_UNIT': F.UNITS[0],
            '_SYSTEMD_INVOCATION_ID': 'a'*32,
            '_CMDLINE': '/usr/bin/python3 -I -B /usr/local/lib/aihr-admission/next_fixture_poststart.py '+F.UNITS[0],
            'MESSAGE': N.ENVIRONMENT_OBSERVATION_PREFIX+json.dumps(value or self.value()) if message is None else message}
        row.update(changes or {})
        return (json.dumps(row)+'\n').encode()

    def receive(self, rows, sources=None, binding=None):
        actual_sources, actual_binding = self.sources()
        return F.runtime_environment_journal_observation(rows, F.UNITS[0], 'a'*32, '/usr/bin/python3.12',
            sources if sources is not None else actual_sources, binding if binding is not None else actual_binding)

    def test_exact_known_vocabulary_and_always_allowed_locale_labels(self):
        self.assertEqual(len(N.ENVIRONMENT_OBSERVATION_NAMES), 59)
        self.assertEqual(len(set(N.ENVIRONMENT_OBSERVATION_NAMES.values())), 59)
        names = dict.fromkeys(N.ENVIRONMENT_OBSERVATION_NAMES, 'fictional-private-value')
        value = N.environment_observation_counts(raw(names))
        self.assertEqual(value['allowedCount'], 2)
        self.assertEqual(value['unqualifiedCount'], 57)
        self.assertEqual(value['otherUnqualifiedCount'], 0)
        self.assertFalse(value['knownUnqualified']['locale-lang'])
        self.assertFalse(value['knownUnqualified']['locale-all'])
        self.assertTrue(value['knownUnqualified']['locale-language'])
        self.assertNotIn('fictional-private-value', json.dumps(value))

    def test_pure_counts_never_claim_process_or_source_authority(self):
        value = N.environment_observation_counts(raw({'NODE_ENV': 'production', 'PORT': '4100'}))
        self.assertEqual(value['allowedCount'], 2)
        self.assertEqual(value['unqualifiedCount'], 0)
        self.assertFalse(value['forbiddenPresent'])
        self.assertEqual(set(value), N.ENVIRONMENT_COUNTS_KEYS)
        self.assertTrue(all(item is False for item in value['knownUnqualified'].values()))
        self.assertNotIn('sourceVerified', value)
        with self.assertRaises(ValueError):
            N.validate_environment_observation(value, 'worker-1')

    def test_unknown_keys_values_and_prefix_variants_remain_aggregate_only(self):
        value = N.environment_observation_counts(raw({'fictional-secret-key': '/private/fictional-token',
            'LANGUAGE_EXTRA': 'secret-canary', 'NEXT_RUNTIME_EXTRA': 'secret-canary'}))
        self.assertEqual(value['otherUnqualifiedCount'], 3)
        self.assertEqual(value['unqualifiedCount'], 3)
        self.assertFalse(any(value['knownUnqualified'].values()))
        public = json.dumps(value)
        for private in ('fictional-secret-key', '/private/fictional-token', 'LANGUAGE_EXTRA', 'NEXT_RUNTIME_EXTRA', 'secret-canary'):
            self.assertNotIn(private, public)

    def test_malformed_utf8_missing_nul_empty_duplicate_and_oversized_sources_refuse(self):
        for source in (b'', b'\0', b'LANG=C', b'LANG=C\0\0', b'no-equals\0', b'=empty-key\0',
                       b'LANG=C\0LANG=C\0', b'x=\xff\0', b'x=' + b'a'*1024**2 + b'\0'):
            with self.subTest(size=len(source)), self.assertRaises((ValueError, UnicodeError)):
                N.environment_observation_counts(source)

    def test_original_environment_guard_still_refuses_known_unknown_and_forbidden_fields(self):
        runtime = object.__new__(N.NextRuntime)
        runtime.require = require
        runtime.private_environment = {'values': {}}
        runtime.value = {'resourceEnvelope': {'workers': 2}}
        values = {'NODE_ENV': 'production', 'PORT': '4100', 'AIHR_APP_WORKERS': '2',
                  'AIHR_DB_TOTAL_CONNECTIONS': '16', 'AIHR_DB_POOL_MAX': '8'}
        runtime._environment(raw(values), 4100)
        for key in ('LANGUAGE', 'LC_NUMERIC', 'NEXT_RUNTIME', 'fictional-secret-key'):
            source = raw(values | {key: 'fictional-private'})
            N.environment_observation_counts(source)
            with self.assertRaisesRegex(AssertionError, '^Unqualified actual worker environment field$'):
                runtime._environment(source, 4100)
        with self.assertRaisesRegex(AssertionError, '^Unsafe actual worker environment override$'):
            runtime._environment(raw(values | {'NODE_OPTIONS': '--fictional-private'}), 4100)

    def test_native_owner_authority_requires_both_custody_checks_and_stable_pinned_process(self):
        value, calls = self.observe()
        self.assertEqual(calls, ['custody', 'custody'])
        self.assertIs(N.validate_environment_observation(value, 'worker-1'), value)
        self.assertTrue(value['processStable'] and value['invocationMatched'] and value['sourceVerified'])
        self.assertFalse(value['nextApplicationVerified'] or value['releaseEligible'])

    def test_foreign_principal_invocation_command_cgroup_and_pid_reuse_refuse(self):
        for changes in ({'uid': 0}, {'invocation': 'b'*32}, {'field': 'cmdline'},
                        {'field': 'cgroup'}, {'field': 'exe'}, {'field': 'cwd'}, {'named_inode': 99}, {'second_ticks': b'9999'}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.observe(**changes)

    def test_unknown_or_changed_custody_never_yields_a_native_success(self):
        for fail_at in (1, 2):
            def custody(count):
                if count == fail_at:
                    raise ValueError('fictional-private-source-change')
            with self.assertRaisesRegex(ValueError, 'fictional-private-source-change'):
                self.observe(custody=custody)
        with self.assertRaises(ValueError):
            N.observe_owned_environment(self.expected(), lambda: None, 0)

    def test_closed_receiver_rejects_extra_missing_unknown_labels_and_inconsistent_counts(self):
        good = self.value()
        variants = [good | {'private': 'fictional-token'}, {k:v for k,v in good.items() if k != 'processStable'},
            good | {'sourceVerified': False}, good | {'version': True}, good | {'subject': 'worker-2'},
            good | {'unqualifiedCount': good['unqualifiedCount'] + 1}, good | {'otherUnqualifiedCount': True},
            good | {'knownUnqualified': good['knownUnqualified'] | {'unknown-native-field': True}},
            good | {'knownUnqualified': good['knownUnqualified'] | {'locale-lang': True},
                    'unqualifiedCount': good['unqualifiedCount']+1}, good | {'releaseEligible': True}]
        for value in variants:
            with self.subTest(keys=list(value)), self.assertRaises(ValueError):
                N.validate_environment_observation(value, 'worker-1')

    def test_root_helper_journal_branch_requires_exact_source_and_native_metadata(self):
        good = self.value()
        self.assertEqual(self.receive(self.journal(good)), [good])
        for changes in ({'_UID': '65534'}, {'_EXE': '/foreign/python'}, {'_SYSTEMD_UNIT': F.UNITS[1]},
                        {'_SYSTEMD_INVOCATION_ID': 'b'*32}, {'_CMDLINE': 'foreign private command'}, {'_CMDLINE': []}):
            self.assertEqual(self.receive(self.journal(good, changes)), [])
        sources, binding = self.sources()
        with self.assertRaises(AssertionError):
            self.receive(self.journal(good), sources | {'poststart': sources['poststart']+b'\n'}, binding)

    def test_journal_duplicate_records_duplicate_keys_and_extra_payload_fields_refuse(self):
        good = self.journal()
        with self.assertRaises(AssertionError):
            self.receive(good+good)
        with self.assertRaises(ValueError):
            self.receive(self.journal(self.value() | {'rawEnvironment': 'fictional-private'}))
        message = N.ENVIRONMENT_OBSERVATION_PREFIX+'{"version":1,"version":1}'
        with self.assertRaises(AssertionError):
            self.receive(self.journal(message=message))
        self.assertEqual(self.receive(self.journal(message='fictional-private-unknown-message')), [])

    def test_original_controller_literal_branch_does_not_accept_helper_observation_as_admission(self):
        result = F.runtime_journal_observation(self.journal(), F.UNITS[0], 'a'*32, '/usr/bin/python3.12', {})
        self.assertEqual(result['trustedControllerRecords'], 0)
        self.assertEqual(result['literalRefusals'], [])
        self.assertEqual(result['closedExceptions'], [])

    def test_fixed_journal_message_fits_existing_bounds_with_all_known_labels(self):
        value = self.value()
        value.update(N.environment_observation_counts(raw(dict.fromkeys(N.ENVIRONMENT_OBSERVATION_NAMES, 'fictional'))))
        message = N.ENVIRONMENT_OBSERVATION_PREFIX.encode()+N.canonical(value)
        self.assertLessEqual(len(message), 4096)
        self.assertLessEqual(len(message), F.RUNTIME_DIAGNOSTIC_MAX)
        N.validate_environment_observation(value, 'worker-1')

    def test_observation_budget_and_telemetry_failures_cancel_timer_and_restore_handler(self):
        for observation_error, write_error in ((TimeoutError('private'), None), (ValueError('private'), None), (None, OSError('private'))):
            calls = []
            with patch.object(P.signal, 'getsignal', return_value=signal.SIG_DFL), \
                    patch.object(P.signal, 'getitimer', return_value=(0.0, 0.0)), \
                    patch.object(P.signal, 'signal', side_effect=lambda *args: calls.append(('handler', args))), \
                    patch.object(P.signal, 'setitimer', side_effect=lambda *args: calls.append(('timer', args))), \
                    patch.object(P, 'full_observation', side_effect=observation_error, return_value=b'closed\n'), \
                    patch.object(P.os, 'write', side_effect=write_error):
                P.best_effort_observation(F.UNITS[0])
            self.assertIn(('timer', (signal.ITIMER_REAL, 1)), calls)
            self.assertEqual(calls[-2:], [('timer', (signal.ITIMER_REAL, 0)), ('handler', (signal.SIGALRM, signal.SIG_DFL))])

    def test_even_keyboard_interrupt_in_observation_executes_original_scrubbed_admission(self):
        # The exact historical exec course is checked after a genuine whole rewind.
        P=types.ModuleType('historical_ffe8_poststart');P.__file__=str(ROOT/'deploy/admission/next_fixture_poststart.py')
        exec(compile(_fresh_parent_bytes('deploy/admission/next_fixture_poststart.py'),P.__file__,'exec'),P.__dict__)
        class ExecObserved(BaseException):
            pass
        info = types.SimpleNamespace(st_uid=0, st_nlink=1, st_mode=0o600)
        with patch.object(P.os, 'geteuid', return_value=0), patch.object(P.sys, 'argv', ['fixed', F.UNITS[0]]), \
                patch.object(pathlib.Path, 'exists', return_value=True), patch.object(pathlib.Path, 'lstat', return_value=info), \
                patch.object(pathlib.Path, 'is_symlink', return_value=False), patch.object(pathlib.Path, 'is_file', return_value=True), \
                patch.dict(P.os.environ, {'INVOCATION_ID': 'a'*32}, clear=True), \
                patch.object(P, 'best_effort_observation', side_effect=KeyboardInterrupt('fictional-private')), \
                patch.object(P.os, 'execve', side_effect=ExecObserved) as execute:
            with self.assertRaises(ExecObserved):
                P.main()
            execute.assert_called_once_with('/usr/bin/python3', ['/usr/bin/python3', '-I', '-B',
                '/usr/local/lib/aihr-admission/controller.py', 'admit', F.UNITS[0]],
                {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C', 'LC_ALL': 'C', 'INVOCATION_ID': 'a'*32})

    def test_expired_native_read_never_opens_additional_environment_data(self):
        with patch.object(N.os, 'open', return_value=100), patch.object(N.os, 'close') as close, \
                patch.object(N.os, 'read') as read:
            with self.assertRaises(TimeoutError):
                N.environment_process_read(100, 'environ', 1024**2, 0)
            read.assert_not_called()
            close.assert_called_once_with(100)


class PhaseDiagnosticModels(unittest.TestCase):
    def base(self):
        return EnvironmentObservationModels()

    def packet(self, phase='timer-armed', result='entered', cause='none'):
        index = P.PHASES.index(phase)
        return {'version': 1, 'kind': 'OWNED_OBSERVER_PHASE_NOT_ENVIRONMENT_OR_ADMISSION',
            'subject': 'worker-1', 'sequence': index if result == 'entered' else index + 1,
            'phase': phase, 'result': result, 'cause': cause}

    def journal(self, value, changes=None):
        return self.base().journal(message=P.PHASE_PREFIX+json.dumps(value), changes=changes)

    def receive(self, raw):
        sources, binding = self.base().sources()
        return F.runtime_environment_journal_diagnostic(raw, F.UNITS[0], 'a'*32, '/usr/bin/python3.12', sources, binding)

    def test_actual_tracker_emits_exact_bounded_closed_order_without_native_authority(self):
        messages = []
        with patch.object(P.time, 'monotonic', return_value=1), patch.object(P.os, 'write', side_effect=lambda _fd, message: messages.append(message) or len(message)):
            tracker = P.PhaseTracker(F.UNITS[0], 2)
            for phase in P.PHASES:
                tracker.enter(phase)
            tracker.finish()
        self.assertEqual(len(messages), 14)
        self.assertLessEqual(sum(map(len, messages))+4096, 18432)
        packets = [json.loads(message[len(P.PHASE_PREFIX):]) for message in messages]
        self.assertEqual([row['phase'] for row in packets[:-1]], list(P.PHASES))
        self.assertEqual([row['sequence'] for row in packets], list(range(14)))
        for message, row in zip(messages, packets):
            self.assertTrue(message.endswith(b'\n'));self.assertLessEqual(len(message), 1024)
            self.assertIs(P.validate_phase_observation(row, 'worker-1'), row)
            self.assertNotIn('sourceVerified', row);self.assertNotIn('processStable', row)
        result = self.receive(b''.join(self.journal(row) for row in packets))
        self.assertEqual(result['observations'], []);self.assertEqual(result['diagnostic']['state'], 'phase-only')
        self.assertEqual(result['diagnostic']['phases'], packets)

    def test_closed_failure_families_never_publish_private_errors_or_extra_fields(self):
        for error, cause in ((ValueError('PRIVATE-VALUE'), 'refused'), (AssertionError('PRIVATE-VALUE'), 'refused'),
                (TimeoutError('PRIVATE-VALUE'), 'budget'), (OSError('PRIVATE-VALUE'), 'io'), (KeyboardInterrupt('PRIVATE-VALUE'), 'other')):
            messages = []
            with patch.object(P.time, 'monotonic', return_value=1), patch.object(P.os, 'write', side_effect=lambda _fd, message: messages.append(message) or len(message)):
                tracker=P.PhaseTracker(F.UNITS[0], 2);tracker.enter(P.PHASES[0]);tracker.fail(error)
            terminal=json.loads(messages[-1][len(P.PHASE_PREFIX):]);self.assertEqual(terminal['cause'], cause)
            self.assertEqual(terminal['result'], 'failed');self.assertNotIn('PRIVATE-VALUE', b''.join(messages).decode())
        for changed in ({'sourceVerified': True}, {'phase': 'PRIVATE'}, {'sequence': True}, {'cause': 'PRIVATE'}, {'result': 'ready'}, {'subject': 'host-component'}):
            with self.assertRaises(ValueError):P.validate_phase_observation(self.packet() | changed, 'worker-1')

    def test_partial_write_expiry_and_occupied_timer_never_retry_or_start_more_observation(self):
        with patch.object(P.time, 'monotonic', return_value=1), patch.object(P.os, 'write', return_value=1) as write:
            tracker=P.PhaseTracker(F.UNITS[0], 2)
            with self.assertRaises(OSError):tracker.enter(P.PHASES[0])
            tracker.fail(OSError('PRIVATE'));self.assertEqual(write.call_count, 1)
        with patch.object(P.time, 'monotonic', return_value=2), patch.object(P.os, 'write') as write:
            tracker=P.PhaseTracker(F.UNITS[0], 2)
            with self.assertRaises(TimeoutError):tracker.enter(P.PHASES[0])
            tracker.fail(TimeoutError('PRIVATE'));write.assert_not_called()
        with patch.object(P.signal, 'getitimer', return_value=(1.0, 0.0)), patch.object(P.os, 'write') as write, patch.object(P, 'full_observation') as observe, patch.object(P.signal, 'setitimer') as timer:
            P.best_effort_observation(F.UNITS[0]);write.assert_not_called();observe.assert_not_called();timer.assert_not_called()

    def test_real_best_effort_failure_reports_only_its_entered_phase_and_restores_original_timer(self):
        messages, timers = [], []
        with patch.object(P.time, 'monotonic', return_value=1), patch.object(P.signal, 'getitimer', return_value=(0.0, 0.0)), \
                patch.object(P.signal, 'getsignal', return_value=signal.SIG_DFL), patch.object(P.signal, 'signal'), \
                patch.object(P.signal, 'setitimer', side_effect=lambda *args: timers.append(args)), \
                patch.object(P.os, 'write', side_effect=lambda _fd, message: messages.append(message) or len(message)), \
                patch.object(P, 'full_observation', side_effect=ValueError('PRIVATE')):
            P.best_effort_observation(F.UNITS[0])
        packets=[json.loads(message[len(P.PHASE_PREFIX):]) for message in messages]
        self.assertEqual(packets, [self.packet(), self.packet(result='failed', cause='refused')])
        self.assertEqual(timers, [(signal.ITIMER_REAL, 1), (signal.ITIMER_REAL, 0)])

    def test_census_preserves_untrusted_controller_foreign_and_missing_metadata_without_reflection(self):
        command='/usr/bin/python3 -I -B /usr/local/lib/aihr-admission/controller.py admit '+F.UNITS[0]
        raw=self.journal(self.packet(), {'_CMDLINE':command})+self.journal(self.packet(), {'_UID':'65534', '_CMDLINE':'PRIVATE'})
        result=self.receive(raw)['diagnostic'];self.assertEqual(result['state'], 'untrusted-candidates-only');self.assertEqual(result['phases'], [])
        self.assertEqual(result['census']['phaseCandidates'], 2);self.assertEqual(result['census']['trustedHelperCandidates'], 0)
        self.assertEqual(result['census']['commandClasses'], {'helper':0,'controller':1,'other-or-missing':1})
        self.assertNotIn('PRIVATE', json.dumps(result))
        self.assertEqual(self.receive(self.base().journal(message='PRIVATE'))['diagnostic']['state'], 'no-candidates')
        for field in ('_UID','_EXE','_SYSTEMD_UNIT','_SYSTEMD_INVOCATION_ID','_CMDLINE'):
            diagnostic=self.receive(self.journal(self.packet(), {field:'PRIVATE'}))['diagnostic']
            self.assertEqual(diagnostic['phases'], []);self.assertEqual(diagnostic['state'], 'untrusted-candidates-only')

    def test_bad_phase_ledgers_and_optional_receiver_failure_never_discard_original_valid_observation(self):
        valid=self.base().journal();first=self.journal(self.packet())
        for broken in (first+first, self.journal(self.packet(P.PHASES[1])), first+self.journal(self.packet(result='failed',cause='io'))+first,
                self.journal(self.packet() | {'profile':'PRIVATE'}), self.base().journal(message=P.PHASE_PREFIX+'{"version":1,"version":1}')):
            result=self.receive(valid+broken);self.assertEqual(result['observations'], [self.base().value()])
            self.assertEqual(result['diagnostic']['state'], 'receiver-unavailable');self.assertTrue(result['diagnostic']['phaseUnavailable']);self.assertEqual(result['diagnostic']['phases'], [])
        with patch.object(F, '_runtime_environment_phase_diagnostic', side_effect=RuntimeError('PRIVATE')):
            result=self.receive(valid)
        self.assertEqual(result['observations'], [self.base().value()]);self.assertIsNone(result['diagnostic']['census']);self.assertNotIn('PRIVATE', json.dumps(result))

    def test_shared_native_hook_subsequence_is_exact_and_never_a_full_helper_ledger(self):
        stages=[];value,_=self.base().observe(phase=stages.append)
        self.assertEqual(stages, ['declaration-before','process-before','environment-read','environment-classified','process-after','custody-after'])
        self.assertFalse(value['nextApplicationVerified'] or value['releaseEligible'])
        diagnostic=self.receive(b''.join(self.journal(self.packet(stage)) for stage in stages))['diagnostic']
        self.assertEqual(diagnostic['state'], 'receiver-unavailable');self.assertEqual(diagnostic['phases'], [])
        with self.assertRaisesRegex(OSError, 'PRIVATE'):
            self.base().observe(phase=lambda _stage: (_ for _ in ()).throw(OSError('PRIVATE')))

    def test_every_original_native_check_and_environment_validator_remains_whole_source_exact(self):
        layer=json.loads((ROOT/'deploy/admission/next_phase_observation_inverse.json').read_text())
        self.assertEqual(layer['base'], '847139e7a2f29faf7a00ffaf17b80739d53acc0e')
        terminal=json.loads((ROOT/'deploy/admission/next_phase_terminal_latch_inverse.json').read_text())
        self.assertEqual(terminal['base'], '74de8af009aa0ed39d8077343d9662b5dc31bbc8')
        key_layer=json.loads((ROOT/'deploy/admission/next_key_name_digest_inverse.json').read_text())
        self.assertEqual(key_layer['base'], '4d4375a489e152772a0f225057ec41c5534b9aa9')
        capability=json.loads((ROOT/'deploy/admission/next_key_name_capability_inverse.json').read_text())
        self.assertEqual(capability['base'], '80a564ef2258613bc8b9489dcc6a3ac709442a34')
        receipt=json.loads((ROOT/'deploy/admission/next_host_key_receipt_inverse.json').read_text())
        self.assertEqual(receipt['base'], 'c0456f6a98e5f3feaf11ca4d759d57c8b76e25da')
        def restored4d(name):
            source=(ROOT/name).read_text()
            for current_layer in (receipt,capability,key_layer):
                if name not in current_layer['files']:
                    continue
                row=current_layer['files'][name];self.assertEqual(hashlib.sha256(source.encode()).hexdigest(),row['currentSha256'])
                lines=source.splitlines(keepends=True)
                for edit in row['changes']:
                    self.assertEqual(''.join(lines[edit['start']:edit['end']]),edit['after']);lines[edit['start']:edit['end']]=edit['before'].splitlines(keepends=True)
                source=''.join(lines);self.assertEqual(hashlib.sha256(source.encode()).hexdigest(),row['originalSha256'])
            return source
        for name in set(receipt['files']) | set(capability['files']) | set(key_layer['files']):restored4d(name)
        originals={}
        for name,row in layer['files'].items():
            source=restored4d(name)
            if name in terminal['files']:
                fixed=terminal['files'][name];self.assertEqual(hashlib.sha256(source.encode()).hexdigest(), fixed['currentSha256'])
                lines=source.splitlines(keepends=True)
                for edit in fixed['changes']:
                    self.assertEqual(''.join(lines[edit['start']:edit['end']]), edit['after']);lines[edit['start']:edit['end']]=edit['before'].splitlines(keepends=True)
                source=''.join(lines);self.assertEqual(hashlib.sha256(source.encode()).hexdigest(), fixed['originalSha256'])
            self.assertEqual(hashlib.sha256(source.encode()).hexdigest(), row['currentSha256'])
            lines=source.splitlines(keepends=True)
            for edit in row['changes']:
                self.assertEqual(''.join(lines[edit['start']:edit['end']]), edit['after']);lines[edit['start']:edit['end']]=edit['before'].splitlines(keepends=True)
            originals[name]=''.join(lines);self.assertEqual(hashlib.sha256(originals[name].encode()).hexdigest(), row['originalSha256'])
        def function(text,name):
            tree=ast.parse(text);return ast.get_source_segment(text,next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name==name))
        name='deploy/admission/next_profile.py';original=originals[name];current=restored4d(name)
        reduced='\n'.join(line for line in current.split('\n') if 'if _phase is not None: _phase(' not in line).replace(', *, _phase=None):', '):')
        self.assertEqual(reduced, original)
        name='deploy/admission/test_next_native.py';self.assertEqual(function((ROOT/name).read_text(),'runtime_environment_journal_observation'),function(originals[name],'runtime_environment_journal_observation'))
        name='deploy/admission/next_fixture_poststart.py';self.assertEqual(function(_fresh_parent_bytes(name).decode(),'main'),function(originals[name],'main'))

    def test_actual_post_write_async_abort_cannot_publish_a_second_terminal_frame(self):
        inverse=json.loads((ROOT/'deploy/admission/next_phase_terminal_latch_inverse.json').read_text())
        row=inverse['files']['deploy/admission/next_fixture_poststart.py']
        parent=base64.b64decode(row['originalBase64']).decode()
        self.assertEqual(hashlib.sha256(parent.encode()).hexdigest(), row['originalSha256'])
        old=types.ModuleType('exact74_terminal_latch_parent');old.__file__=P.__file__
        exec(compile(parent, old.__file__, 'exec', dont_inherit=True), old.__dict__)
        def exercise(module, text):
            tree=ast.parse(text);owner=next(node for node in tree.body if isinstance(node,ast.ClassDef) and node.name=='PhaseTracker')
            write=next(node for node in owner.body if isinstance(node,ast.FunctionDef) and node.name=='write')
            native_try=next(node for node in write.body if isinstance(node,ast.Try))
            boundary=next(node.lineno for node in write.body if node.lineno>native_try.end_lineno)
            code=module.PhaseTracker.write.__code__;self.assertEqual(code.co_firstlineno, write.lineno)
            packets=[];state={'terminalWritten':False,'interrupted':False}
            def output(_fd, message):
                value=json.loads(message[len(module.PHASE_PREFIX):]);packets.append(value)
                if value['result']=='finished':state['terminalWritten']=True
                return len(message)
            def interrupt(frame, event, _arg):
                if (frame.f_code is code and event=='line' and frame.f_lineno==boundary
                        and state['terminalWritten'] and not state['interrupted']):
                    state['interrupted']=True
                    raise KeyboardInterrupt('Fictional exact post-write interruption')
                return interrupt
            with patch.object(module.time, 'monotonic', return_value=1), patch.object(module.os, 'write', side_effect=output):
                tracker=module.PhaseTracker(F.UNITS[0], 2)
                for phase in module.PHASES:tracker.enter(phase)
                previous=sys.gettrace()
                try:
                    sys.settrace(interrupt)
                    with self.assertRaises(KeyboardInterrupt):tracker.finish()
                finally:
                    sys.settrace(previous)
                self.assertIs(sys.gettrace(), previous)
                tracker.fail(KeyboardInterrupt('Fictional original best-effort error path'))
            self.assertTrue(state['terminalWritten'] and state['interrupted'])
            return packets
        # Run both actual byte-bound owners at the real post-try boundary: old
        # publishes finished+failed; new latches before write and publishes one.
        previous=exercise(old,parent);current=exercise(P,(ROOT/'deploy/admission/next_fixture_poststart.py').read_text())
        self.assertEqual([row['result'] for row in previous if row['result']!='entered'], ['finished','failed'])
        self.assertEqual([row['result'] for row in current if row['result']!='entered'], ['finished'])
        self.assertEqual(len(previous),15);self.assertEqual(len(current),14)
        # A terminal write that is partial or throws remains terminal/uncertain;
        # even the actual best-effort failure path cannot try another record.
        for outcome in (1, OSError('Fictional uncertain terminal transport')):
            with patch.object(P.time, 'monotonic', return_value=1), patch.object(P.os, 'write', side_effect=lambda _fd, message: len(message)):
                tracker=P.PhaseTracker(F.UNITS[0],2)
                for phase in P.PHASES:tracker.enter(phase)
            with patch.object(P.time, 'monotonic', return_value=1), patch.object(P.os, 'write', side_effect=outcome if isinstance(outcome,BaseException) else lambda _fd,_message: outcome) as write:
                with self.assertRaises(OSError):tracker.finish()
                tracker.fail(KeyboardInterrupt('Fictional later abort'))
                self.assertEqual(write.call_count,1);self.assertTrue(tracker.terminal and tracker.broken)

class KeyNameDigestModels(unittest.TestCase):
    def base(self):
        return EnvironmentObservationModels()

    def phase_models(self):
        return PhaseDiagnosticModels()

    def keys(self, count=1):
        return ['FICTIONAL_UNKNOWN_KEY_' + str(i) for i in range(count)]

    def value(self, count=1):
        return N.key_name_digests(self.keys(count), count)

    def environment(self, count=1):
        return self.base().observe(environment_values={'INVOCATION_ID': 'a'*32} | dict.fromkeys(self.keys(count), 'FICTIONAL_PRIVATE_VALUE'))[0]

    def terminal(self, keys=None):
        return {'version': 2, 'kind': 'CLOSED_PHASE_TERMINAL_KEY_NAME_DIGEST_NOT_ADMISSION',
            'phase': self.phase_models().packet(P.PHASES[-1], 'finished'), 'keyNames': keys if keys is not None else self.value()}

    def journal(self, terminal=None, count=1, with_environment=True):
        models=self.phase_models()
        rows=self.base().journal(self.environment(count)) if with_environment else b''
        rows+=b''.join(models.journal(models.packet(name)) for name in P.PHASES)
        return rows+self.base().journal(message=P.TERMINAL_PREFIX+json.dumps(terminal if terminal is not None else self.terminal()))

    def test_complete_zero_one_four_and_strict_utf8_names_never_encode_values_or_known_names(self):
        for count in (0,1,4):
            names=self.keys(count)+['NODE_ENV','LANGUAGE','LANG','INVOCATION_ID']
            value=N.key_name_digests(names,count)
            expected=sorted(hashlib.sha256(b'AIHR_INITIAL_ENV_OTHER_KEY_NAME_SHA256_V1\0'+name.encode('utf8')).hexdigest() for name in self.keys(count))
            self.assertEqual(value['digests'],expected);self.assertEqual(value['count'],count)
            self.assertEqual(value['state'],'complete');self.assertNotIn('sourceVerified',value)
            for name in names:self.assertNotIn(name,json.dumps(value))
        name='FICTIONAL_鍵_😀';self.assertEqual(N.key_name_digests([name],1)['digests'],[hashlib.sha256(N.KEY_NAME_DIGEST_DOMAIN+name.encode('utf8')).hexdigest()])
        first=N.environment_observation_values(raw({'FICTIONAL_KEY':'PRIVATE-FIRST'}))
        second=N.environment_observation_values(raw({'FICTIONAL_KEY':'PRIVATE-SECOND-LONGER'}))
        self.assertEqual(N.key_name_digests(first.keys(),1),N.key_name_digests(second.keys(),1))
        self.assertNotIn('PRIVATE',json.dumps(N.key_name_digests(first.keys(),1)))

    def test_overflow_has_no_prefix_and_duplicate_collision_mismatch_or_surrogate_refuses(self):
        value=N.key_name_digests(self.keys(5),5)
        self.assertEqual(value,N.unavailable_key_name_digests(5,'overflow'));self.assertEqual(value['digests'],[])
        for names,count in [(['FICTIONAL','FICTIONAL'],1),(['FICTIONAL'],0),(['\ud800'],1),([''],1),(['A=B'],1),(['A\0B'],1)]:
            with self.assertRaises((ValueError,UnicodeError)):N.key_name_digests(names,count)
        digest=types.SimpleNamespace(hexdigest=lambda:'a'*64)
        with patch.object(N.hashlib,'sha256',return_value=digest),self.assertRaises(ValueError):N.key_name_digests(self.keys(2),2)

    def test_closed_key_codec_rejects_boolean_count_unknown_state_extra_raw_data_and_bad_hash_sets(self):
        good=self.value(2)
        variants=[good|{'version':True},good|{'count':True},good|{'digests':good['digests'][:1]},good|{'digests':good['digests'][::-1]},
            good|{'digests':[good['digests'][0]]*2},good|{'digests':['X'*64]*2},good|{'rawName':'FICTIONAL_PRIVATE'},
            good|{'state':'ready'},good|{'state':'unavailable','digests':[],'reason':'overflow'},N.unavailable_key_name_digests(5)|{'reason':'capture-unavailable'}]
        for value in variants:
            with self.assertRaises(ValueError):N.validate_key_name_digests(value)
        with self.assertRaises(ValueError):N.validate_key_name_digests(good,1)
        with self.assertRaises(ValueError):N.validate_environment_observation(good,'worker-1')

    def test_native_capture_seam_uses_one_existing_environ_read_and_keys_only_before_postchecks(self):
        reads,stages,captured=[],[],[]
        def capture(keys,count):
            self.assertIs(type(keys),tuple);self.assertFalse(hasattr(keys,'mapping'))
            self.assertTrue(all(type(name) is str for name in keys))
            self.assertNotIn('PRIVATE-VALUE',keys)
            with self.assertRaises(TypeError):keys[0]='FICTIONAL_REPLACEMENT'
            captured.append(N.key_name_digests(keys,count))
        value,custody=self.base().observe(environment_values={'INVOCATION_ID':'a'*32,'FICTIONAL_UNKNOWN':'PRIVATE-VALUE'},
            read_calls=reads,key_names=capture,phase=stages.append)
        self.assertEqual(reads.count('environ'),1);self.assertEqual(reads,['stat','cgroup','cmdline','environ','stat','cgroup','cmdline'])
        self.assertEqual(custody,['custody','custody']);self.assertEqual(stages,['declaration-before','process-before','environment-read','environment-classified','process-after','custody-after'])
        self.assertEqual(captured[0]['count'],value['otherUnqualifiedCount']);self.assertNotIn('PRIVATE-VALUE',json.dumps(captured))
        with self.assertRaises(ValueError):self.base().observe(key_names=capture,second_ticks=b'9999')
        # Source-bound old capability counterexample; inspect the actual frozen
        # parent's AST, then use only Python's builtin view on fictional data.
        inverse=json.loads((ROOT/'deploy/admission/next_key_name_capability_inverse.json').read_text())
        row=inverse['files']['deploy/admission/next_profile.py'];parent=base64.b64decode(row['originalBase64']).decode()
        self.assertEqual(hashlib.sha256(parent.encode()).hexdigest(),row['originalSha256'])
        owner=next(node for node in ast.parse(parent).body if isinstance(node,ast.FunctionDef) and node.name=='observe_owned_environment')
        call=next(node for node in ast.walk(owner) if isinstance(node,ast.Call) and isinstance(node.func,ast.Name) and node.func.id=='_key_names')
        self.assertEqual(ast.dump(call.args[0],include_attributes=False),ast.dump(ast.parse('values.keys()',mode='eval').body,include_attributes=False))
        fictional={'FICTIONAL_NAME':'PRIVATE-VALUE'};view=fictional.keys();copy=tuple(fictional)
        self.assertEqual(view.mapping['FICTIONAL_NAME'],'PRIVATE-VALUE');self.assertFalse(hasattr(copy,'mapping'))
        fictional['FICTIONAL_LATER']='PRIVATE-LATER';self.assertEqual(copy,('FICTIONAL_NAME',))

    def test_terminal_v2_keeps_fourteen_rows_fifteen_messages_and_original_phase_codec(self):
        messages=[]
        with patch.object(P.time,'monotonic',return_value=1),patch.object(P.os,'write',side_effect=lambda _fd,message:messages.append(message) or len(message)):
            tracker=P.PhaseTracker(F.UNITS[0],2)
            for phase in P.PHASES:tracker.enter(phase)
            tracker.capture_keys(self.value(4),N.validate_key_name_digests);tracker.finish()
        self.assertEqual(len(messages),14);self.assertTrue(all(len(message)<=1024 and message.endswith(b'\n') for message in messages))
        self.assertTrue(all(message.startswith(P.PHASE_PREFIX.encode()) for message in messages[:-1]))
        self.assertTrue(messages[-1].startswith(P.TERMINAL_PREFIX.encode()));self.assertLessEqual(sum(map(len,messages))+4096,18432)
        terminal=json.loads(messages[-1][len(P.TERMINAL_PREFIX):]);P.validate_terminal_observation(terminal,'worker-1',N.validate_key_name_digests)
        self.assertEqual(terminal['phase'],self.phase_models().packet(P.PHASES[-1],'finished'))
        self.assertIs(P.validate_phase_observation(terminal['phase'],'worker-1'),terminal['phase'])
        with self.assertRaises(ValueError):P.validate_phase_observation(terminal,'worker-1')

    def test_source_sealed_terminal_joins_real_shaped_v1_and_counts_each_record_only_once(self):
        models=self.phase_models();rows=self.journal()+b''.join(self.base().journal(message='closed noncandidate') for _ in range(6))
        result=models.receive(rows);diag=result['diagnostic'];keys=diag['keyNameDiagnostic']
        self.assertEqual(len(diag['phases']),14);self.assertEqual(diag['census']['records'],21)
        self.assertEqual(diag['census']['phaseCandidates'],14);self.assertEqual(diag['census']['environmentCandidates'],1)
        self.assertEqual(diag['census']['trustedHelperCandidates'],15);self.assertEqual(diag['census']['metadataMatches'],dict.fromkeys(('uid','executable','unit','invocation'),15))
        self.assertEqual(result['observations'],[self.environment()]);self.assertEqual(keys['helperCompletion'],'finished')
        self.assertEqual(keys['state'],'complete');self.assertEqual(keys['digests'],self.value()['digests'])
        self.assertNotIn('FICTIONAL_UNKNOWN',json.dumps(result));self.assertNotIn('FICTIONAL_PRIVATE_VALUE',json.dumps(result))

    def test_missing_native_environment_or_unfinished_helper_never_publishes_digest_authority(self):
        models=self.phase_models();diag=models.receive(self.journal(with_environment=False))['diagnostic']['keyNameDiagnostic']
        self.assertEqual(diag['state'],'unavailable');self.assertEqual(diag['helperCompletion'],'finished');self.assertEqual(diag['digests'],[])
        self.assertEqual(diag['reason'],'environment-observation-missing')
        result=models.receive(self.base().journal(self.environment()))
        self.assertEqual(result['observations'],[self.environment()]);self.assertEqual(result['diagnostic']['keyNameDiagnostic']['state'],'helper-not-finished')
        old=self.base().journal(self.environment())+b''.join(models.journal(models.packet(name)) for name in P.PHASES)+models.journal(models.packet(P.PHASES[-1],'finished'))
        diag=models.receive(old)['diagnostic']['keyNameDiagnostic'];self.assertEqual(diag['state'],'unavailable');self.assertEqual(diag['reason'],'terminal-v2-absent')

    def test_malformed_duplicate_wrong_subject_count_or_prefix_terminal_preserves_old_v1_observation(self):
        models=self.phase_models();good=self.terminal();variants=[good|{'version':True},good|{'rawName':'PRIVATE'},good|{'keyNames':self.value(2)},
            good|{'phase':good['phase']|{'subject':'worker-2'}},good|{'phase':models.packet()},good|{'keyNames':good['keyNames']|{'digests':[]}}]
        for terminal in variants:
            result=models.receive(self.journal(terminal));self.assertEqual(result['observations'],[self.environment()])
            self.assertTrue(result['diagnostic']['phaseUnavailable']);self.assertEqual(result['diagnostic']['keyNameDiagnostic']['digests'],[])
        prefix=self.base().journal(self.environment())+b''.join(models.journal(models.packet(name)) for name in P.PHASES)
        for tail in [self.base().journal(message=P.TERMINAL_PREFIX+json.dumps(good).replace('"version": 2','"version": 2, "version": 2',1)),
                self.base().journal(message=P.PHASE_PREFIX+json.dumps(good))]:
            result=models.receive(prefix+tail);self.assertEqual(result['observations'],[self.environment()]);self.assertTrue(result['diagnostic']['phaseUnavailable'])
        result=models.receive(self.journal()+models.journal(models.packet(P.PHASES[-1],'finished')))
        self.assertEqual(result['observations'],[self.environment()]);self.assertTrue(result['diagnostic']['phaseUnavailable'])

    def test_unavailable_overflow_is_finished_metadata_not_hash_or_readiness_success(self):
        result=self.phase_models().receive(self.journal(self.terminal(N.unavailable_key_name_digests(5)),count=5))
        self.assertEqual(result['observations'],[self.environment(5)]);diag=result['diagnostic']
        self.assertFalse(diag['phaseUnavailable']);self.assertEqual(diag['keyNameDiagnostic']['helperCompletion'],'finished')
        self.assertEqual(diag['keyNameDiagnostic']['state'],'unavailable');self.assertEqual(diag['keyNameDiagnostic']['reason'],'overflow');self.assertEqual(diag['keyNameDiagnostic']['digests'],[])
        self.assertFalse(result['observations'][0]['nextApplicationVerified'] or result['observations'][0]['releaseEligible'])

    def test_v2_terminal_uncertain_write_and_actual_post_try_abort_cannot_publish_a_second_terminal(self):
        source=(ROOT/'deploy/admission/next_fixture_poststart.py').read_text();tree=ast.parse(source)
        owner=next(node for node in tree.body if isinstance(node,ast.ClassDef) and node.name=='PhaseTracker')
        write=next(node for node in owner.body if isinstance(node,ast.FunctionDef) and node.name=='write');native_try=next(node for node in write.body if isinstance(node,ast.Try))
        boundary=next(node.lineno for node in write.body if node.lineno>native_try.end_lineno);code=P.PhaseTracker.write.__code__
        records=[];state={'written':False,'aborted':False}
        def output(_fd,message):
            records.append(message)
            if message.startswith(P.TERMINAL_PREFIX.encode()):state['written']=True
            return len(message)
        def interrupt(frame,event,_arg):
            if frame.f_code is code and event=='line' and frame.f_lineno==boundary and state['written'] and not state['aborted']:
                state['aborted']=True;raise KeyboardInterrupt('Fictional post-write abort')
            return interrupt
        with patch.object(P.time,'monotonic',return_value=1),patch.object(P.os,'write',side_effect=output):
            tracker=P.PhaseTracker(F.UNITS[0],2)
            for phase in P.PHASES:tracker.enter(phase)
            tracker.capture_keys(self.value(),N.validate_key_name_digests);previous=sys.gettrace()
            try:
                sys.settrace(interrupt)
                with self.assertRaises(KeyboardInterrupt):tracker.finish()
            finally:sys.settrace(previous)
            self.assertIs(sys.gettrace(),previous);tracker.fail(KeyboardInterrupt('Fictional best-effort error'))
        self.assertTrue(state['aborted']);self.assertEqual(len(records),14);self.assertEqual(sum(message.startswith(P.TERMINAL_PREFIX.encode()) for message in records),1)
        for outcome in (1,OSError('Fictional uncertain write')):
            with patch.object(P.time,'monotonic',return_value=1),patch.object(P.os,'write',side_effect=lambda _fd,message:len(message)):
                tracker=P.PhaseTracker(F.UNITS[0],2)
                for phase in P.PHASES:tracker.enter(phase)
                tracker.capture_keys(self.value(),N.validate_key_name_digests)
            with patch.object(P.time,'monotonic',return_value=1),patch.object(P.os,'write',side_effect=outcome if isinstance(outcome,BaseException) else lambda _fd,_message:outcome) as writing:
                with self.assertRaises(OSError):tracker.finish()
                tracker.fail(KeyboardInterrupt());self.assertEqual(writing.call_count,1);self.assertTrue(tracker.terminal and tracker.broken)

    def test_host_component_six_hooks_and_canary_data_cannot_be_a_full_worker_terminal(self):
        host=self.environment()|{'subject':'host-component'}
        with self.assertRaises(ValueError):self.base().receive(self.base().journal(host))
        terminal=self.terminal();terminal['phase']['subject']='host-component'
        with self.assertRaises(ValueError):P.validate_terminal_observation(terminal,'worker-1',N.validate_key_name_digests)
        keys=N.key_name_digests(['AIHR_OBSERVATION_CANARY'],1)
        self.assertEqual(keys['digests'],[hashlib.sha256(N.KEY_NAME_DIGEST_DOMAIN+b'AIHR_OBSERVATION_CANARY').hexdigest()])
        self.assertNotIn('fullHelperVerified',keys);self.assertNotIn('sourceVerified',keys)

    def test_whole_native_guards_v1_codecs_original_exec_and_single_read_are_source_exact(self):
        inverse=json.loads((ROOT/'deploy/admission/next_key_name_digest_inverse.json').read_text())
        def original(name):
            row=inverse['files'][name];value=base64.b64decode(row['originalBase64']).decode()
            self.assertEqual(hashlib.sha256(value.encode()).hexdigest(),row['originalSha256']);return value
        def functions(text):
            tree=ast.parse(text);return {node.name:ast.get_source_segment(text,node) for node in tree.body if isinstance(node,ast.FunctionDef)}
        for name,names in [('deploy/admission/next_profile.py',['environment_observation_values','environment_observation_counts','validate_environment_observation','forbidden_environment']),
                ('deploy/admission/next_fixture_poststart.py',['validate_phase_observation','main']),('deploy/admission/test_next_native.py',['runtime_environment_journal_observation','runtime_journal_observation'])]:
            old,new=functions(original(name)),functions(_fresh_parent_bytes(name).decode() if name=='deploy/admission/next_fixture_poststart.py' else (ROOT/name).read_text())
            for function in names:self.assertEqual(new[function],old[function])
        old=ast.parse(original('deploy/admission/next_profile.py'));new=ast.parse((ROOT/'deploy/admission/next_profile.py').read_text())
        runtime=lambda tree:next(node for node in tree.body if isinstance(node,ast.ClassDef) and node.name=='NextRuntime')
        method=lambda tree,name:ast.dump(next(node for node in runtime(tree).body if isinstance(node,ast.FunctionDef) and node.name==name),include_attributes=False)
        self.assertEqual(method(old,'_environment'),method(new,'_environment'))
        native=next(node for node in new.body if isinstance(node,ast.FunctionDef) and node.name=='observe_owned_environment')
        reads=[node for node in ast.walk(native) if isinstance(node,ast.Call) and isinstance(node.func,ast.Name) and node.func.id=='environment_process_read' and len(node.args)>1 and isinstance(node.args[1],ast.Constant) and node.args[1].value=='environ']
        self.assertEqual(len(reads),1)
        digest=functions((ROOT/'deploy/admission/next_profile.py').read_text())['key_name_digests']
        self.assertNotIn('os.environ',digest);self.assertNotIn('getenvironment',digest);self.assertNotIn('environment_process_read',digest)
        function=ast.parse(digest).body[0];self.assertEqual([arg.arg for arg in function.args.args],['keys','expected_count'])
        self.assertFalse(any(isinstance(node,ast.Attribute) and node.attr=='values' for node in ast.walk(function)))



class FreshChildOwnerModels(unittest.TestCase):
    """Fake stdlib handles only; no native unit/process/admission claim."""
    class ExitObserved(BaseException):
        def __init__(self, code):self.code=code

    def exercise(self, status=0, *, host=False, failure=None, cleanup=(), terminate_failure=None, kill_failure=None):
        events=[]
        class Child:
            returncode=None
            def wait(child, timeout=None):
                events.append(('wait', timeout))
                if timeout is None and failure is not None:raise failure
                if timeout is not None and cleanup:
                    outcome=cleanup[min(sum(e[0]=='wait' and e[1] is not None for e in events)-1,len(cleanup)-1)]
                    if isinstance(outcome,BaseException):raise outcome
                child.returncode=status;return status
            def terminate(child):
                events.append(('terminate',))
                if terminate_failure:raise terminate_failure
            def kill(child):
                events.append(('kill',))
                if kill_failure:raise kill_failure
        child=Child()
        own='/var/lib/aihr-next-host-conformance/next_fixture_poststart.py' if host else '/usr/local/lib/aihr-admission/next_fixture_poststart.py'
        argv=['/var/lib/aihr-next-host-conformance/probe.py','hook-post'] if host else [own,F.UNITS[0]]
        def exit_(code):raise self.ExitObserved(code)
        with patch.object(P,'__file__',own),patch.object(P.os,'geteuid',return_value=0),patch.object(P.pathlib.Path,'resolve',side_effect=lambda *a,**k:pathlib.Path(own)),patch.object(P.sys,'argv',argv),patch.dict(P.os.environ,{'INVOCATION_ID':'a'*32,'PRIVATE_KEY':'fictional'},clear=True),patch.object(P.subprocess,'Popen',return_value=child) as spawn,patch.object(P.os,'_exit',side_effect=exit_),patch.object(P.os,'write') as write,patch.object(P.os,'kill') as kill,patch.object(P.signal,'signal') as disposition,patch.object(P.signal,'pthread_sigmask') as mask:
            with self.assertRaises(self.ExitObserved) as caught:P._fixed_child(None if host else F.UNITS[0])
        return caught.exception.code,events,spawn,write,kill,disposition,mask

    def test_fresh_owner_exact_two_fixed_contexts_and_inherited_stream_flags(self):
        for host in (False,True):
            result,events,spawn,*_=self.exercise(host=host)
            self.assertEqual(result,0);self.assertEqual(events,[('wait',None)])
            argv=spawn.call_args.args[0]
            self.assertEqual(argv,['/usr/bin/python3','-I','-B','/var/lib/aihr-next-host-conformance/probe.py','hook-post-child'] if host else ['/usr/bin/python3','-I','-B','/usr/local/lib/aihr-admission/controller.py','admit',F.UNITS[0]])
            self.assertEqual(spawn.call_args.kwargs,{'env':{'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C','LC_ALL':'C','INVOCATION_ID':'a'*32},'stdin':P.subprocess.DEVNULL,'close_fds':True})

    def test_fresh_owner_zero_and_nonzero_status_are_exact_after_reap(self):
        for status in (0,1,17,255):
            result,events,spawn,write,*_=self.exercise(status)
            self.assertEqual(result,status);self.assertEqual(events,[('wait',None)]);self.assertEqual(spawn.call_count,1);write.assert_not_called()

    def test_fresh_owner_terminal_signals_never_become_numeric_success(self):
        for sig in (signal.SIGTERM,signal.SIGKILL):
            result,events,spawn,write,kill,disposition,mask=self.exercise(-sig)
            self.assertEqual(result,1)  # A returning fake kill is explicitly unavailable.
            kill.assert_called_once_with(os.getpid(),sig)
            if sig==signal.SIGKILL:disposition.assert_not_called();mask.assert_not_called()
            else:disposition.assert_called_once_with(sig,signal.SIG_DFL);mask.assert_called_once_with(signal.SIG_UNBLOCK,{sig})
        for status in (-signal.SIGSTOP,-signal.SIGCHLD,-999,True,None,256):
            result,events,spawn,write,kill,*_=self.exercise(status)
            self.assertEqual(result,1);kill.assert_not_called()

    def test_fresh_owner_observation_baseexception_still_invokes_current_child_once(self):
        class Called(BaseException):pass
        info=types.SimpleNamespace(st_uid=0,st_nlink=1,st_mode=0o600)
        for failure in (KeyboardInterrupt('private'),SystemExit(7),TimeoutError('private')):
            with patch.object(P.os,'geteuid',return_value=0),patch.object(P.sys,'argv',['fixed',F.UNITS[0]]),patch.object(pathlib.Path,'exists',return_value=True),patch.object(pathlib.Path,'lstat',return_value=info),patch.object(pathlib.Path,'is_symlink',return_value=False),patch.object(pathlib.Path,'is_file',return_value=True),patch.object(P,'best_effort_observation',side_effect=failure),patch.object(P,'_fixed_child',side_effect=Called) as launch:
                with self.assertRaises(Called):P.main()
                launch.assert_called_once_with(F.UNITS[0])

    def test_fresh_owner_wait_interrupt_and_secondary_failures_still_attempt_kill_and_reap(self):
        for failure in (KeyboardInterrupt('private'),SystemExit(9),OSError('private')):
            result,events,spawn,*_=self.exercise(failure=failure,cleanup=(P.subprocess.TimeoutExpired('fixed',1),0))
            self.assertEqual(result,1);self.assertEqual([e[0] for e in events],['wait','terminate','wait','kill','wait']);self.assertEqual(spawn.call_count,1)
            self.assertTrue(0<events[2][1]<=1 and 0<events[4][1]<=2)
        result,events,*_=self.exercise(failure=KeyboardInterrupt(),cleanup=(KeyboardInterrupt(),KeyboardInterrupt()))
        self.assertEqual(result,1);self.assertIn(('kill',),events)
        for term,kill in ((OSError('private terminate'),None),(KeyboardInterrupt(),OSError('private kill'))):
            result,events,*_=self.exercise(failure=KeyboardInterrupt(),cleanup=(KeyboardInterrupt(),KeyboardInterrupt()),terminate_failure=term,kill_failure=kill)
            self.assertEqual(result,1);self.assertEqual([e[0] for e in events],['wait','terminate','wait','kill','wait'])

    def test_fresh_owner_refuses_foreign_context_and_constructor_failure_without_retry(self):
        with patch.object(P.os,'geteuid',return_value=0),patch.object(P.subprocess,'Popen') as spawn:
            with self.assertRaises(AssertionError):P._fixed_child('arbitrary')
            spawn.assert_not_called()
        own='/usr/local/lib/aihr-admission/next_fixture_poststart.py'
        def child_exit(code):raise self.ExitObserved(code)
        with patch.object(P,'__file__',own),patch.object(P.pathlib.Path,'resolve',return_value=pathlib.Path(own)),patch.object(P.os,'geteuid',return_value=0),patch.object(P.sys,'argv',[own,F.UNITS[0]]),patch.dict(P.os.environ,{'INVOCATION_ID':'a'*32},clear=True),patch.object(P.subprocess,'Popen',side_effect=OSError('private')) as spawn,patch.object(P.os,'write') as write,patch.object(P.os,'_exit',side_effect=child_exit) as exit_:
            with self.assertRaises(self.ExitObserved) as observed:P._fixed_child(F.UNITS[0])
            self.assertEqual(observed.exception.code,1)
            self.assertEqual(spawn.call_count,1);exit_.assert_called_once_with(1);write.assert_called_once_with(2,b'Fixed post-start child refused\n')


if __name__ == '__main__':
    unittest.main()
