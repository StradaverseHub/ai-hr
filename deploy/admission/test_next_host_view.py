"""Synthetic descriptor/policy/settlement models only; no sudo/systemd/app/DB."""
import importlib.util
import os
import pathlib
import stat
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[2]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


N = load('model_cache_view', ROOT / 'deploy/admission/next_profile.py')
I = load('model_cache_inventory', ROOT / '.github/ci/runtime_inventory.py')
F = load('model_cache_cleanup', ROOT / 'deploy/admission/test_next_native.py')


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

    def cleanup_model(self, *, foreign_browser=False, failed_stop=False, foreign_slice=False, success=False):
        units = [*F.UNITS, F.PROXY] + ([F.SLICE] if foreign_slice else [])
        calls, unlinks = [], []
        def props(unit):
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
            return types.SimpleNamespace(stdout=b'', returncode=0)
        info = types.SimpleNamespace(st_mode=stat.S_IFREG | 0o644, st_uid=0, st_dev=1, st_ino=2)
        patches = [patch.object(F, 'owned_units', {unit: (1, 2) for unit in units}),
            patch.object(F, 'owned_invocations', {unit: 'a' * 32 for unit in units}),
            patch.object(F, 'managed_runtime_module', N), patch.object(F, 'report', {'runId': '1'}),
            patch.object(F, 'TOTAL_DEADLINE', 1000), patch.object(F.time, 'monotonic', return_value=100),
            patch.object(F, 'props', side_effect=props), patch.object(F, 'systemctl', side_effect=command),
            patch.object(F, 'require_stopped', return_value=None), patch.object(F, 'browser', None),
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
        self.assertIn('DEADLINE = min(TOTAL_DEADLINE, time.monotonic() + 30)', source)
        self.assertIn('raise BaseExceptionGroup', source)


if __name__ == '__main__':
    unittest.main()
