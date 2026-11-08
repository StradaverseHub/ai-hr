"""Source models only; no native/root/systemd/app/DB or environment discovery."""
import ast
import copy
import hashlib
import json
import pathlib
import signal
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


class EnvironmentObservationModels(unittest.TestCase):
    def expected(self):
        return dict(pid=42, invocation='a'*32, uid=65534, executable='/owned/node', cwd='/owned/release',
            cgroup='/owned/worker', argv=['/owned/node', 'start'], title=None, subject='worker-1')

    def observe(self, *, uid=65534, invocation=None, field=None, second_ticks=None, custody=None, named_inode=2, phase=None):
        expected = self.expected()
        stat_calls = 0
        def read(_fd, name, _bound, _deadline):
            nonlocal stat_calls
            if name == 'stat':
                stat_calls += 1
                ticks = second_ticks if stat_calls == 2 and second_ticks is not None else b'1234'
                return b'42 (model comm) ' + b' '.join([b'S'] + [b'0']*18 + [ticks])
            if name == 'environ':
                return raw({'INVOCATION_ID': invocation or 'a'*32, 'LANGUAGE': 'fictional-private'})
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
            value = N.observe_owned_environment(expected, own, float('inf'), _phase=phase)
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
        originals={}
        for name,row in layer['files'].items():
            source=(ROOT/name).read_text();self.assertEqual(hashlib.sha256(source.encode()).hexdigest(), row['currentSha256'])
            lines=source.splitlines(keepends=True)
            for edit in row['changes']:
                self.assertEqual(''.join(lines[edit['start']:edit['end']]), edit['after']);lines[edit['start']:edit['end']]=edit['before'].splitlines(keepends=True)
            originals[name]=''.join(lines);self.assertEqual(hashlib.sha256(originals[name].encode()).hexdigest(), row['originalSha256'])
        def function(text,name):
            tree=ast.parse(text);return ast.get_source_segment(text,next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name==name))
        name='deploy/admission/next_profile.py';original=originals[name];current=(ROOT/name).read_text()
        reduced='\n'.join(line for line in current.split('\n') if 'if _phase is not None: _phase(' not in line).replace(', *, _phase=None):', '):')
        self.assertEqual(reduced, original)
        name='deploy/admission/test_next_native.py';self.assertEqual(function((ROOT/name).read_text(),'runtime_environment_journal_observation'),function(originals[name],'runtime_environment_journal_observation'))
        name='deploy/admission/next_fixture_poststart.py';self.assertEqual(function((ROOT/name).read_text(),'main'),function(originals[name],'main'))


if __name__ == '__main__':
    unittest.main()
