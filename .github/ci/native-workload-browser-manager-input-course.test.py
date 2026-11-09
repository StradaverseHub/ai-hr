"""Data and custody models for the fixed no-role manager diagnostic."""
from contextlib import contextmanager
from pathlib import Path
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch


def load(filename):
    source = Path(__file__).with_name(filename)
    module = ModuleType(filename)
    module.__file__ = str(source)
    exec(compile(source.read_bytes(), str(source), 'exec', dont_inherit=True), module.__dict__)
    return module


B = load('native-controller-bootstrap.py')
M = load('native-workload-browser-manager-input-course.py')
HEADER = b'Num RefCount Protocol Flags Type St Inode Path\n'
LISTENER = b'0000000000000000: 00000002 00000000 00010000 0001 01 22352 /run/dbus/system_bus_socket\n'
ACCEPTED = b'0000000000000000: 00000002 00000000 00000000 0001 03 22991 /run/dbus/system_bus_socket\n'


class ManagerInputModels(unittest.TestCase):
    def environment(self, branch):
        ref, sha = 'refs/heads/' + branch, 'a' * 40
        environment = {'GITHUB_ACTIONS': 'true', 'CI': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted',
                       'RUNNER_OS': 'Linux', 'GITHUB_REPOSITORY': 'StradaverseHub/ai-hr',
                       'GITHUB_REPOSITORY_ID': '1333414856', 'GITHUB_RUN_ATTEMPT': '1',
                       'GITHUB_WORKFLOW': 'alpha-staging-ci', 'GITHUB_JOB': 'native-test',
                       'GITHUB_RUN_ID': '123', 'GITHUB_SHA': sha, 'AIHR_CI_HEAD': sha,
                       'AIHR_CI_CONTROL_HEAD': sha, 'GITHUB_WORKFLOW_SHA': sha, 'GITHUB_REF': ref,
                       'GITHUB_REF_NAME': branch, 'GITHUB_REF_TYPE': 'branch', 'GITHUB_EVENT_NAME': 'workflow_dispatch',
                       'GITHUB_WORKFLOW_REF': 'StradaverseHub/ai-hr/.github/workflows/alpha-staging.yml@' + ref,
                       'GITHUB_WORKSPACE': '/home/runner/work/ai-hr/ai-hr', 'RUNNER_TEMP': '/home/runner/work/_temp',
                       'RUNNER_TOOL_CACHE': '/opt/hostedtoolcache'}
        event = {'ref': branch, 'repository': {'id': 1333414856, 'full_name': 'StradaverseHub/ai-hr'},
                 'inputs': {'candidate_ref': branch, 'expected_sha': sha, 'test_parallelism': '4',
                            'build_only': 'false', 'diagnostics_only': 'true', 'controller_only': 'false',
                            'native_tool_only': 'false', 'native_browser_stage_only': 'true'}}
        return environment, event

    def test_only_exact_dispatch_enters_each_separate_selector(self):
        manager, event = self.environment(B.MANAGER_INPUT_BRANCH)
        old, old_event = self.environment(B.BROWSER_STAGE_BRANCH)
        self.assertEqual(B.manager_input_intent(manager, event)[0], '123')
        self.assertEqual(B.browser_stage_intent(old, old_event)[0], '123')
        for env, payload in ((old, old_event), (manager, old_event), ({**manager, 'GITHUB_RUN_ATTEMPT': '2'}, event)):
            with self.subTest(env=env.get('GITHUB_REF')), self.assertRaises(ValueError):
                B.manager_input_intent(env, payload)
        for inputs in ({'unexpected': ''}, {'native_tool_only': 'true'}, {'commission_singleton_units': 'anything'},
                       {'expected_sha': 'b' * 40}, {'native_browser_stage_only': True}):
            with self.subTest(inputs=inputs), self.assertRaises(ValueError):
                B.manager_input_intent(manager, {**event, 'inputs': {**event['inputs'], **inputs}})
        with self.assertRaises(ValueError):
            B.browser_stage_intent(manager, event)
        with self.assertRaises(ValueError):
            B.prepare_tool(browser_stage=True, manager_input=True)

    def test_only_one_live_stream_listener_for_the_exact_path(self):
        self.assertEqual(M._listener_inode(HEADER + ACCEPTED + LISTENER), 22352)
        for raw in (HEADER + ACCEPTED, HEADER + LISTENER * 2, HEADER + LISTENER.replace(b'0001 01', b'0002 01'),
                    HEADER + LISTENER.replace(b'00010000', b'00010001'),
                    HEADER + LISTENER.replace(b'_socket', b'_socket.other'),
                    HEADER + LISTENER.replace(b'22352', b'022352'), HEADER + LISTENER * 8193):
            with self.subTest(size=len(raw)), self.assertRaises(ValueError):
                M._listener_inode(raw)

    def test_held_library_description_requires_the_original_exact_bytes_and_extent(self):
        raw = b'exact'
        described = SimpleNamespace(size=5, sha256='a' * 64, soname='libsystemd.so.0',
                                    needed=('libc.so.6',), selected_tags=(), flags=None, flags_1=None)
        admission = Mock()
        admission._describe_fixed_library_link_inputs.return_value = described
        observed = SimpleNamespace(check_pid1=Mock(), library_fd=9, library_bytes=5, library_sha256='a' * 64)
        with patch.object(M.os, 'pread', side_effect=[b'ex', b'act', b''], create=True) as pread:
            self.assertEqual(M._library(admission, observed, 32)['needed'], ['libc.so.6'])
            self.assertEqual([call.args for call in pread.call_args_list], [(9, 5, 0), (9, 3, 2), (9, 1, 5)])
        admission._describe_fixed_library_link_inputs.assert_called_once_with(raw)
        self.assertEqual(observed.check_pid1.call_count, 2)
        for chunks in ([b''], [raw, b'extra']):
            with self.subTest(chunks=chunks), patch.object(M.os, 'pread', side_effect=chunks, create=True):
                with self.assertRaisesRegex(ValueError, 'library-extent'):
                    M._library(admission, observed, 32)
        described.sha256 = 'b' * 64
        with patch.object(M.os, 'pread', side_effect=[raw, b''], create=True):
            with self.assertRaisesRegex(ValueError, 'library-extent'):
                M._library(admission, observed, 32)

    def test_owner_closure_refusal_cannot_promote_native_facts(self):
        admission = Mock()
        observed = SimpleNamespace(check_pid1=Mock())

        @contextmanager
        def drift(_view, _host, _mounts, *, started_ns, ready_by_ns):
            self.assertEqual(ready_by_ns - started_ns, 32 * M._SECOND)
            yield observed
            raise ValueError('untrusted raw path')

        admission.held_manager_inputs.side_effect = drift
        with patch.object(M, '_library', return_value={'fictional': True}), \
             patch.object(M, '_listener_ownership', return_value=['pid1']):
            self.assertEqual(M.observe_manager_inputs(admission, None, SimpleNamespace(Refused=RuntimeError), None),
                             {'failure': {'phase': 'owner-settlement', 'reason': 'owned-observation-refused'}})

    def test_capture_refuses_wrong_context_or_any_activation_claim(self):
        environment, _ = self.environment(B.MANAGER_INPUT_BRANCH)
        report = {'kind': 'NATIVE_STOCK_MANAGER_INPUTS', 'complete': True, 'source': 'a' * 40,
                  'controller': 'a' * 40, 'runId': '123', 'attempt': 1, 'job': 'native-test',
                  'eventSha256': 'b' * 64, 'sourceCapsuleSha256': 'c' * 64,
                  **dict.fromkeys(B.MANAGER_INPUT_INACTIVE, False),
                  'observation': {'pid1AndBothPathViewsMatched': True, 'elapsedMs': 87,
                                  'listener': {'stockFdHolders': ['pid1', 'dbus-daemon'], 'cgroupAndImageMatched': True},
                                  'library': {'bytes': 1024, 'sha256': 'd' * 64, 'soname': 'libsystemd.so.0',
                                              'needed': ['libc.so.6'], 'selectedTags': [], 'flags': None, 'flags1': 1}}}
        B._validate_manager_input_capture(B.canonical(report), '0', environment)
        for changes in ({'runId': '124'}, {'attempt': True}, {'failure': 'unexpected'}, {'note': 'unexpected'},
                        *({key: True} for key in B.MANAGER_INPUT_INACTIVE)):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                B._validate_manager_input_capture(B.canonical({**report, **changes}), '0', environment)
        with self.assertRaises(ValueError):
            B._validate_manager_input_capture(B.canonical(report), '1', environment)


if __name__ == '__main__':
    unittest.main()
