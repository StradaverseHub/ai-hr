"""Source models only; no native/root/systemd/app/DB or environment discovery."""
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

    def observe(self, *, uid=65534, invocation=None, field=None, second_ticks=None, custody=None, named_inode=2):
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
            value = N.observe_owned_environment(expected, own, float('inf'))
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


if __name__ == '__main__':
    unittest.main()
