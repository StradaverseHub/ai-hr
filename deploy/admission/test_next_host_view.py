"""Synthetic descriptor/policy/settlement models only; no sudo/systemd/app/DB."""
import importlib.util
import hashlib
import json
import os
import pathlib
import stat
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[2]


def load(name, file):
    module = types.ModuleType(name);module.__file__ = str(file)
    exec(compile(file.read_bytes(), str(file), 'exec', dont_inherit=True), module.__dict__)
    return module


N = load('model_cache_view', ROOT / 'deploy/admission/next_profile.py')
I = load('model_cache_inventory', ROOT / '.github/ci/runtime_inventory.py')
F = load('model_cache_cleanup', ROOT / 'deploy/admission/test_next_native.py')
H = load('model_host_cleanup', ROOT / 'deploy/admission/test_next_host_view_native.py')


def require(value, reason):
    if not value:
        raise AssertionError(reason)


class HostViewModels(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='next-host-view-source-')
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name).resolve()
        for target in N.CACHE_TARGETS:
            (self.root / target).mkdir(parents=True, mode=0o755)
            (self.root / target).chmod(0o755)

    def view(self, mounts=()):
        with I.PinnedTree(self.root, require) as tree, patch.object(N, 'parse_mountinfo', return_value=list(mounts)):
            return N.immutable_cache_view(str(self.root), tree, {}, 65534, require,
                                         lambda *_args, **_kwargs: None, os.getuid())

    def test_resource_guard_diagnostic_returns_only_closed_source_reasons(self):
        for message, reason in [('Missing nonroot ancestor resource cap', 'missing-nonroot-cap'),
                                ('Ancestor memory cap is below accepted app envelope', 'ancestor-memory-too-low'),
                                ('Ancestor CPU cap is below accepted app envelope', 'ancestor-cpu-too-low')]:
            self.assertEqual(H.resource_guard_reason(AssertionError(message)), reason)
        for message in ['private secret /home/fictional', 'Missing nonroot ancestor resource cap\n', '']:
            self.assertEqual(H.resource_guard_reason(AssertionError(message)), 'resource-check-refused')

    def test_implicit_slice_absence_never_adopts_a_source_dropin_transient_or_kernel_group(self):
        value = {'LoadState': 'loaded', 'ActiveState': 'inactive', 'SubState': 'dead', 'FragmentPath': '',
                 'DropInPaths': '', 'SourcePath': '', 'Transient': 'no', 'ControlGroup': ''}
        with patch.object(H, 'properties', return_value=value), patch.object(H.os.path, 'lexists', return_value=False):
            self.assertTrue(H.declaration_absent(H.AGGREGATE))
            for changes in ({'FragmentPath': '/foreign/unit'}, {'DropInPaths': '/foreign/dropin'},
                            {'SourcePath': '/foreign/source'}, {'Transient': 'yes'}, {'ControlGroup': '/foreign'},
                            {'ActiveState': 'active'}, {'SubState': 'running'}):
                with patch.object(H, 'properties', return_value=value | changes):
                    self.assertFalse(H.declaration_absent(H.AGGREGATE))
            for missing in ('FragmentPath', 'DropInPaths', 'SourcePath', 'Transient', 'ControlGroup'):
                with patch.object(H, 'properties', return_value={key: item for key, item in value.items() if key != missing}):
                    self.assertFalse(H.declaration_absent(H.AGGREGATE))
        with patch.object(H, 'properties', return_value=value), \
                patch.object(H.os.path, 'lexists', side_effect=lambda path: str(path).startswith('/sys/fs/cgroup')):
            self.assertFalse(H.declaration_absent(H.AGGREGATE))

    def test_slice_unknown_process_foreign_directory_and_nested_directory_are_retained(self):
        group = self.root / 'synthetic-group';group.mkdir();(group / 'cgroup.procs').write_text('')
        worker = group / H.UNIT;worker.mkdir()
        with patch.object(H, 'aggregate_directory', return_value=group), patch.object(H, 'secure'), \
                patch.object(N, 'kernel_text', side_effect=lambda path, *_args: path.read_text().strip()):
            H.slice_occupants(N)
            foreign = group / 'foreign.service';foreign.mkdir()
            with self.assertRaisesRegex(AssertionError, 'Foreign slice child'):
                H.slice_occupants(N)
            foreign.rmdir();nested = worker / 'foreign';nested.mkdir()
            with self.assertRaisesRegex(AssertionError, 'Nested foreign'):
                H.slice_occupants(N)
            nested.rmdir();(group / 'cgroup.procs').write_text('999\n')
            with self.assertRaisesRegex(AssertionError, 'Foreign aggregate process'):
                H.slice_occupants(N)

    def test_resource_diagnostic_calls_the_unchanged_method_and_does_not_claim_full_profile_admission(self):
        source = pathlib.Path(H.__file__).read_text()
        self.assertIn('runtime = object.__new__(N.NextRuntime)', source)
        self.assertIn('evidence = runtime.resource_state(UNIT, before_unit)', source)
        self.assertNotIn('N.NextRuntime.resource_state =', source)
        self.assertIn("'profileConstructorVerified': False", source)
        self.assertIn("'resourceReadinessQualified': False", source)
        self.assertIn("TOTAL_DEADLINE - 7", source)
        for fixed in ('CPUQuota=400%', 'MemoryHigh=7168M', 'MemoryMax=8192M', 'MemorySwapMax=0', 'TasksMax=1024'):
            self.assertIn(fixed, source)

    def test_host_empty_placeholders_keep_exact_mode_and_complete_native_identity(self):
        result = self.view()
        self.assertFalse(result['overlaid']);self.assertEqual(set(result['placeholders']), set(N.CACHE_TARGETS))
        for target, identity in result['placeholders'].items():
            self.assertEqual(identity, N.file_identity((self.root / target).stat()))
        (self.root / N.CACHE_TARGETS[0]).chmod(0o700)
        with self.assertRaisesRegex(AssertionError, 'Unsafe immutable'):
            self.view()

    def test_host_nonempty_or_link_placeholder_never_gets_mutable_overlay_exception(self):
        point = self.root / N.CACHE_TARGETS[0];(point / 'foreign').write_text('fixed model')
        with self.assertRaisesRegex(AssertionError, 'not empty'):
            self.view()
        (point / 'foreign').unlink();point.rmdir();point.symlink_to(self.root / N.CACHE_TARGETS[1])
        with self.assertRaises((AssertionError, OSError, ValueError)):
            self.view()

    def test_partial_or_extra_mounts_refuse_before_any_host_root_magic_link(self):
        one = {'target': str(self.root / N.CACHE_TARGETS[0])}
        three = [{'target': str(self.root / target)} for target in N.CACHE_TARGETS]
        with patch.object(N, 'system_manager_root', side_effect=AssertionError('must not reach manager')) as manager:
            for mounts in ([one], [*three, {'target': str(self.root / 'foreign')} ]):
                with self.assertRaisesRegex(AssertionError, 'Unknown or partial'):
                    self.view(mounts)
            manager.assert_not_called()
        import contextlib
        @contextlib.contextmanager
        def same_namespace(*_args):
            current = os.stat('/proc/self/ns/mnt')
            yield -1, (current.st_dev, current.st_ino)
        with I.PinnedTree(self.root, require) as tree, patch.object(N, 'parse_mountinfo', return_value=three), \
                patch.object(N, 'system_manager_root', same_namespace):
            with self.assertRaisesRegex(AssertionError, 'distinct service namespace'):
                N.immutable_cache_view(str(self.root), tree, {}, 65534, require, lambda *_args: None)

    def test_fixed_manager_proc_and_executable_fences_refuse_before_host_root_access(self):
        with patch.object(N.os, 'readlink', return_value='foreign'), patch.object(N.os, 'open') as opened:
            with self.assertRaisesRegex(AssertionError, 'Native proc identity'):
                with N.system_manager_root(require, lambda *_args, **_kwargs: None):
                    self.fail('manager must not yield')
            opened.assert_not_called()
        with patch.object(N.os, 'readlink', return_value=str(os.getpid())), \
                patch.object(N.os, 'open', return_value=100), patch.object(N.os, 'close'), \
                patch.object(N.os, 'fstat', return_value=types.SimpleNamespace(st_uid=1001)):
            with self.assertRaisesRegex(AssertionError, 'proc owner'):
                with N.system_manager_root(require, lambda *_args, **_kwargs: None):
                    self.fail('manager must not yield')
        position = {}
        def opened(name, *_args, **_kwargs):
            return {'/proc/1': 100, 'stat': 101, 'status': 102, 'exe': 103}[name]
        def read(fd, _count):
            if position.get(fd):
                return b''
            position[fd] = True
            return b'1 (systemd) S ' + b'0 ' * 18 + b'1\n' if fd == 101 else b'Name:\tsystemd\nUid:\t0\t0\t0\t0\n'
        with patch.object(N.os, 'readlink', side_effect=lambda name, **_kwargs: str(os.getpid()) if name == '/proc/self' else '/foreign-manager'), \
                patch.object(N.os, 'open', side_effect=opened), patch.object(N.os, 'read', side_effect=read), \
                patch.object(N.os, 'close'), patch.object(N.os, 'fstat', return_value=types.SimpleNamespace(st_uid=0)), \
                patch.object(pathlib.Path, 'stat', return_value=types.SimpleNamespace()):
            with self.assertRaisesRegex(AssertionError, 'executable differs'):
                with N.system_manager_root(require, lambda *_args, **_kwargs: None):
                    self.fail('manager must not yield')

    def test_native_invocation_observation_cannot_adopt_missing_or_foreign_custody(self):
        actual = {'LoadState': 'loaded', 'InvocationID': 'a' * 32}
        N.require_owned_invocation(actual, 'a' * 32, require)
        for expected in (None, '', 'b' * 32, 'a' * 32 + '\n'):
            with self.assertRaises(AssertionError):
                N.require_owned_invocation(actual, expected, require)
        with self.assertRaises(AssertionError):
            N.require_owned_invocation(dict(actual, LoadState='not-found'), 'a' * 32, require)

    def cleanup_model(self, *, foreign_browser=False, failed_stop=False, foreign_slice=False,
                      success=False, stalled_metadata=False, stalled_stop=False, settle_after=0):
        units = [*F.UNITS, F.PROXY] + ([F.SLICE] if foreign_slice else [])
        calls, unlinks, clock = [], [], [100.0]
        def props(unit, timeout=30):
            if stalled_metadata and unit == F.UNITS[0]:
                clock[0] += timeout
                raise TimeoutError('fixed stalled metadata')
            if unit == F.BROWSER:
                return {'LoadState': 'loaded' if foreign_browser else 'not-found', 'InvocationID': 'b' * 32}
            if unit == F.SLICE:
                return {'LoadState': 'loaded', 'InvocationID': 'a' * 32, 'ActiveState': 'active', 'ControlGroup': F.FIXTURE_CGROUP}
            return {'LoadState': 'loaded', 'InvocationID': 'a' * 32, 'MainPID': '0', 'ControlPID': '0',
                    'ActiveState': 'inactive', 'ControlGroup': F.FIXTURE_CGROUP if unit == F.SLICE else ''}
        def command(*args, **kwargs):
            calls.append(args)
            if args == ('show', F.BROWSER, '--property=Description,Transient'):
                return types.SimpleNamespace(stdout=b'Transient=yes\nDescription=Owned actual Next browser 1\n')
            if failed_stop and args == ('stop', '--no-block', F.UNITS[1]):
                raise OSError('fixed source close failure')
            if stalled_stop and args == ('stop', '--no-block', F.UNITS[1]):
                clock[0] += kwargs['timeout']
                raise TimeoutError('fixed stalled stop queue')
            return types.SimpleNamespace(stdout=b'', returncode=0)
        info = types.SimpleNamespace(st_mode=stat.S_IFREG | 0o644, st_uid=0, st_dev=1, st_ino=2)
        patches = [patch.object(F, 'owned_units', {unit: (1, 2) for unit in units}),
            patch.object(F, 'owned_invocations', {unit: 'a' * 32 for unit in units}),
            patch.object(F, 'managed_runtime_module', N), patch.object(F, 'report', {'runId': '1'}),
            patch.object(F, 'TOTAL_DEADLINE', 1000), patch.object(F.time, 'monotonic', side_effect=lambda: clock[0]),
            patch.object(F.time, 'sleep', side_effect=lambda seconds: clock.__setitem__(0, clock[0]+seconds)),
            patch.object(F, 'props', side_effect=props), patch.object(F, 'systemctl', side_effect=command),
            patch.object(F, 'require_stopped', side_effect=lambda *_args: require(clock[0] >= 100+settle_after, 'fixed native stop pending')),
            patch.object(F, 'browser', None),
            patch.object(pathlib.Path, 'lstat', return_value=info),
            patch.object(pathlib.Path, 'unlink', side_effect=lambda *_args, **_kwargs: unlinks.append(True))]
        if foreign_slice:
            class Entries:
                def __enter__(self):
                    return iter([types.SimpleNamespace(is_dir=lambda **_kwargs: True)])
                def __exit__(self, *_args):
                    return False
            patches += [patch.object(pathlib.Path, 'exists', return_value=True),
                patch.object(pathlib.Path, 'is_symlink', return_value=False),
                patch.object(pathlib.Path, 'read_text', return_value=''), patch.object(F.os, 'scandir', return_value=Entries())]
        import contextlib
        with contextlib.ExitStack() as stack:
            for value in patches:
                stack.enter_context(value)
            if success:
                self.assertIsNone(F.cleanup(types.SimpleNamespace(snapshot=lambda _stage: None)))
            else:
                with self.assertRaises(BaseExceptionGroup) as outcome:
                    F.cleanup(None)
                self.last_cleanup_errors = outcome.exception.exceptions
            self.assertLessEqual(F.DEADLINE - 100, 30)
        self.assertEqual(len(unlinks), len(units) if success else 0)
        self.last_cleanup_clock = clock[0]
        return calls

    def test_foreign_browser_refusal_still_stops_every_other_owned_service_and_keeps_paths(self):
        calls = self.cleanup_model(foreign_browser=True)
        self.assertNotIn(('stop', '--no-block', F.BROWSER), calls)
        for unit in [*F.UNITS, F.PROXY]:
            self.assertIn(('stop', '--no-block', unit), calls)

    def test_one_failed_stop_never_prevents_other_independent_stop_attempts(self):
        calls = self.cleanup_model(failed_stop=True)
        for unit in [*F.UNITS, F.PROXY]:
            self.assertIn(('stop', '--no-block', unit), calls)
        original, capture = OSError('fixed native start failure'), AssertionError('fixed custody capture failure')
        with patch.object(F, 'owned_units', {F.UNITS[0]: (1, 2)}), \
                patch.object(F, 'systemctl', side_effect=original), \
                patch.object(F, 'record_owned_invocation', side_effect=capture):
            with self.assertRaises(BaseExceptionGroup) as result:
                F.owned_start(F.UNITS[0])
            self.assertEqual(result.exception.exceptions, (original, capture))

    def test_foreign_slice_child_is_preserved_without_stopping_slice(self):
        calls = self.cleanup_model(foreign_slice=True)
        self.assertNotIn(('stop', F.SLICE), calls)
        self.assertTrue(any(isinstance(error, AssertionError) and str(error) == 'Foreign native slice occupant; preserve runtime' for error in self.last_cleanup_errors))
        for unit in [*F.UNITS, F.PROXY]:
            self.assertIn(('stop', '--no-block', unit), calls)

    def test_browser_stop_and_runtime_bounds_are_explicit_source_contract_not_native_proof(self):
        calls = self.cleanup_model(success=True)
        for unit in [*F.UNITS, F.PROXY]:
            self.assertIn(('stop', '--no-block', unit), calls)
        self.assertIn(('daemon-reload',), calls)
        source = pathlib.Path(F.__file__).read_text()
        self.assertIn("'--property=TimeoutStopSec=3s'", source)
        self.assertIn("'--property=SendSIGKILL=yes'", source)
        self.assertIn("'--property=RuntimeMaxSec=300s'", source)
        self.assertIn('DEADLINE = min(TOTAL_DEADLINE, started + 30)', source)
        self.assertIn('raise BaseExceptionGroup', source)

    def test_stalled_full_metadata_reserves_other_unit_observations_and_stop_queue(self):
        calls = self.cleanup_model(stalled_metadata=True)
        self.assertNotIn(('stop', '--no-block', F.UNITS[0]), calls)
        for unit in [F.UNITS[1], F.PROXY]:
            self.assertIn(('stop', '--no-block', unit), calls)
        self.assertLessEqual(self.last_cleanup_clock, 100.75)
        self.assertTrue(any(isinstance(error, TimeoutError) for error in self.last_cleanup_errors))

    def test_stalled_full_stop_queue_does_not_consume_other_owned_stops(self):
        calls = self.cleanup_model(stalled_stop=True)
        for unit in [*F.UNITS, F.PROXY]:
            self.assertIn(('stop', '--no-block', unit), calls)
        self.assertLessEqual(self.last_cleanup_clock, 100.5)

    def test_full_five_second_native_stop_fits_settlement_without_spending_disposal_reserve(self):
        calls = self.cleanup_model(success=True, settle_after=5)
        self.assertGreaterEqual(self.last_cleanup_clock, 105)
        self.assertLess(self.last_cleanup_clock, 115)
        for unit in [*F.UNITS, F.PROXY]:
            self.assertIn(('stop', '--no-block', unit), calls)

    def test_native_seven_second_cleanup_keeps_independent_stop_after_metadata_or_queue_stall(self):
        for stalled in ('metadata', 'queue'):
            clock, calls, unlinks = [100.0], [], []
            files = {H.UNIT: (1, 2), H.FOREIGN: (1, 2)}
            info = types.SimpleNamespace(st_mode=stat.S_IFREG | 0o644, st_uid=0, st_dev=1, st_ino=2)
            def properties(unit, cap=3):
                if stalled == 'metadata' and unit == H.UNIT:
                    clock[0] += cap
                    raise TimeoutError('fixed stalled conformance metadata')
                return {'LoadState': 'loaded', 'InvocationID': 'a'*32}
            def command(*args, **kwargs):
                calls.append(args)
                self.assertLessEqual(kwargs['cap'], .25)
                if stalled == 'queue' and args[-1] == H.UNIT:
                    clock[0] += kwargs['cap']
                    raise TimeoutError('fixed stalled conformance queue')
            with patch.object(H, 'TOTAL_DEADLINE', 1000), patch.object(H.time, 'monotonic', side_effect=lambda: clock[0]), \
                    patch.object(H, 'properties', side_effect=properties), patch.object(H, 'command', side_effect=command), \
                    patch.object(H, 'family_stopped', return_value=True), patch.object(pathlib.Path, 'lstat', return_value=info), \
                    patch.object(pathlib.Path, 'unlink', side_effect=lambda *_args: unlinks.append(True)):
                with self.assertRaises(BaseExceptionGroup):
                    H.cleanup(files, {name: 'a'*32 for name in files}, N, None)
                self.assertEqual(H.DEADLINE, 107)
            self.assertIn(('/usr/bin/systemctl', '--system', 'stop', '--no-block', H.FOREIGN), calls)
            if stalled == 'metadata':
                self.assertNotIn(('/usr/bin/systemctl', '--system', 'stop', '--no-block', H.UNIT), calls)
            else:
                self.assertIn(('/usr/bin/systemctl', '--system', 'stop', '--no-block', H.UNIT), calls)
            self.assertEqual(unlinks, [])

    def test_replaced_root_is_refused_before_any_unit_or_directory_disposal(self):
        root = self.root / 'owned';root.mkdir();original = root.stat();root.rename(self.root / 'held')
        root.mkdir();(root / 'foreign').write_text('retain foreign native identity')
        replacement = root.stat();self.assertNotEqual(original.st_ino, replacement.st_ino)
        unit_info = types.SimpleNamespace(st_mode=stat.S_IFREG | 0o644, st_uid=0, st_dev=1, st_ino=2)
        foreign_info = types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=0,
            st_dev=replacement.st_dev, st_ino=replacement.st_ino)
        absent = {'LoadState': 'loaded', 'ActiveState': 'inactive', 'SubState': 'dead',
                  'FragmentPath': '', 'DropInPaths': '', 'SourcePath': '',
                  'Transient': 'no', 'ControlGroup': ''}
        absent_paths = {'/etc/systemd/system/' + name for name in H.UNITS}
        absent_paths.add('/sys/fs/cgroup' + H.AGGREGATE_GROUP)
        def info(file):
            return foreign_info if file == root else unit_info
        # First preserve the earlier unknown-declaration refusal. Only the
        # complete implicit-slice facts may reach the later root-inode guard.
        for complete, reason in ((False, 'Untracked native declaration'), (True, 'root replaced')):
            with self.subTest(complete_aggregate_absence=complete):
                calls, unlinks, observed_units, observed_paths = [], [], [], []
                def properties(unit, cap=3):
                    observed_units.append(unit)
                    if unit == H.UNIT:
                        return {'LoadState': 'loaded', 'InvocationID': 'a'*32}
                    if unit == H.AGGREGATE and complete:
                        return dict(absent)
                    return {'LoadState': 'not-found'}
                def lexists(path):
                    self.assertIn(str(path), absent_paths)
                    observed_paths.append(str(path))
                    return False
                with patch.object(H, 'ROOT', root), patch.object(H, 'TOTAL_DEADLINE', 1000), \
                        patch.object(H.time, 'monotonic', return_value=100), patch.object(pathlib.Path, 'lstat', side_effect=info, autospec=True), \
                        patch.object(H, 'properties', side_effect=properties), patch.object(H.os.path, 'lexists', side_effect=lexists), \
                        patch.object(H, 'root_custody', wraps=H.root_custody) as root_guard, \
                        patch.object(H, 'remove_owned_root', wraps=H.remove_owned_root) as dispose, \
                        patch.object(H, 'family_stopped', return_value=True), \
                        patch.object(H, 'command', side_effect=lambda *args, **_kwargs: calls.append(args)), \
                        patch.object(pathlib.Path, 'unlink', side_effect=lambda *_args: unlinks.append(True)):
                    with self.assertRaisesRegex(AssertionError, reason) as refusal:
                        H.cleanup({H.UNIT: (1, 2)}, {H.UNIT: 'a'*32}, N, (original.st_dev, original.st_ino))
                    self.assertEqual(str(refusal.exception), 'Conformance root replaced; retain paths' if complete
                                     else 'Untracked native declaration; retain all paths')
                    if complete:
                        root_guard.assert_called_once_with((original.st_dev, original.st_ino), N)
                        self.assertIn('/sys/fs/cgroup' + H.AGGREGATE_GROUP, observed_paths)
                    else:
                        root_guard.assert_not_called()
                    dispose.assert_not_called()
                self.assertIn(H.AGGREGATE, observed_units)
                self.assertIn(('/usr/bin/systemctl', '--system', 'stop', '--no-block', H.UNIT), calls)
                self.assertEqual(unlinks, [])
                self.assertFalse(any('reset-failed' in call for call in calls))
                self.assertEqual((root / 'foreign').read_text(), 'retain foreign native identity')
        # Separate synthetic mount fact: even a matching owned root cannot be
        # disposed through a same-device host bind. No actual mount is claimed.
        with patch.object(H, 'ROOT', root), patch.object(H, 'DEADLINE', 107), \
                patch.object(H.time, 'monotonic', return_value=100), \
                patch.object(pathlib.Path, 'lstat', return_value=foreign_info), \
                patch.object(N, 'read_proc', return_value=b'fixed synthetic mount input'), \
                patch.object(N, 'parse_mountinfo', return_value=[{'target': str(root / 'foreign-mount')}]), \
                patch.object(H.os, 'unlink') as unlink:
            with self.assertRaisesRegex(AssertionError, 'Foreign host mount'):
                H.remove_owned_root((replacement.st_dev, replacement.st_ino), N)
            unlink.assert_not_called()

    def test_descriptor_disposal_checks_aggregate_deadline_between_actual_owned_members(self):
        root = self.root / 'disposal';root.mkdir();(root / 'one').write_text('owned');(root / 'two').write_text('owned')
        identity = root.stat();clock = [100.0];actual_unlink = os.unlink;removed = []
        def unlink(name, **kwargs):
            actual_unlink(name, **kwargs);removed.append(name);clock[0] += .1
        with patch.object(H, 'ROOT', root), patch.object(H, 'DEADLINE', 100.05), \
                patch.object(H.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(H, 'root_custody', return_value=identity), patch.object(H.os, 'unlink', side_effect=unlink):
            with self.assertRaisesRegex(AssertionError, 'deadline'):
                H.remove_owned_root((identity.st_dev, identity.st_ino), N)
        self.assertEqual(len(removed), 1)
        self.assertTrue(root.exists());self.assertEqual(len(list(root.iterdir())), 1)

    def test_both_complete_predecessor_fixtures_reconstruct_without_dropping_old_guards(self):
        inverse = json.loads((ROOT / 'deploy/admission/next_cleanup_phase_inverse.json').read_text())
        expected = {'deploy/admission/test_next_native.py': '730f34682797f8ecef52b98181ab12f786081caebe1d24f1552d24d6d4ef8632',
                    'deploy/admission/test_next_host_view_native.py': '6d2cb72060fef1d816724e71ccef374b75cc6cd4fca77bbe0471042064a91c7a'}
        self.assertEqual(inverse['kind'], 'NATIVE_NEXT_CLEANUP_PHASE_SOURCE_INVERSE_NOT_EXECUTION')
        self.assertEqual(inverse['base'], 'f37f9d629458b7d2bf4a34bdb3a0891e32af96e2')
        self.assertEqual(set(inverse['files']), set(expected))
        for name, digest in expected.items():
            row = inverse['files'][name];source = (ROOT / name).read_text()
            self.assertEqual(row['originalSha256'], digest)
            self.assertEqual(hashlib.sha256(source.encode()).hexdigest(), row['currentSha256'])
            for change in reversed(row['changes']):
                self.assertEqual(source.count(change['after']), 1)
                source = source.replace(change['after'], change['before'])
            self.assertEqual(hashlib.sha256(source.encode()).hexdigest(), digest)
        # Fixture recovery must not silently rewrite any other original model.
        recovery = json.loads((ROOT / 'deploy/admission/next_cgroup_control_guard_order_inverse.json').read_text())
        self.assertEqual(recovery['base'], '26105ef7e53b088ffec8dc701606a70ce32677d1')
        source = pathlib.Path(__file__).read_text()
        self.assertEqual(hashlib.sha256(source.encode()).hexdigest(), recovery['currentSha256'])
        lines = source.splitlines(keepends=True)
        for change in recovery['changes']:
            self.assertEqual(''.join(lines[change['start']:change['end']]), change['after'])
            lines[change['start']:change['end']] = change['before'].splitlines(keepends=True)
        self.assertEqual(hashlib.sha256(''.join(lines).encode()).hexdigest(), recovery['originalSha256'])


if __name__ == '__main__':
    unittest.main()
