"""Source models for the exclusive TOOL route. No network, sudo or native mount."""
from __future__ import annotations

import pathlib
import sys
import time
import unittest
from contextlib import nullcontext
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock, call, patch


def load(name, filename):
    path = pathlib.Path(__file__).with_name(filename)
    module = ModuleType(name)
    module.__file__ = str(path)
    sys.modules[name] = module
    exec(compile(path.read_bytes(), str(path), 'exec', dont_inherit=True), module.__dict__)
    return module


B = load('tool_course_bootstrap_models', 'native-controller-bootstrap.py')
C = load('tool_course_owner_models', 'native-workload-browser-tool-course.py')
SOURCE = 'a' * 40
REF = 'refs/heads/' + B.TOOL_BRANCH


def environment():
    return {'GITHUB_ACTIONS': 'true', 'CI': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted', 'RUNNER_OS': 'Linux',
            'GITHUB_REPOSITORY': 'StradaverseHub/ai-hr', 'GITHUB_REPOSITORY_ID': '1333414856',
            'GITHUB_RUN_ATTEMPT': '1', 'GITHUB_WORKFLOW': 'alpha-staging-ci', 'GITHUB_JOB': 'native-test',
            'GITHUB_RUN_ID': '123', 'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_WORKFLOW_SHA': SOURCE,
            'GITHUB_SHA': SOURCE, 'AIHR_CI_HEAD': SOURCE, 'AIHR_CI_CONTROL_HEAD': SOURCE,
            'GITHUB_REF': REF, 'GITHUB_REF_NAME': B.TOOL_BRANCH, 'GITHUB_REF_TYPE': 'branch',
            'GITHUB_WORKFLOW_REF': 'StradaverseHub/ai-hr/.github/workflows/alpha-staging.yml@' + REF,
            'GITHUB_WORKSPACE': '/home/runner/work/ai-hr/ai-hr', 'RUNNER_TEMP': '/home/runner/work/_temp',
            'RUNNER_TOOL_CACHE': '/opt/hostedtoolcache'}


def event():
    return {'ref': REF, 'repository': {'id': 1333414856, 'full_name': 'StradaverseHub/ai-hr'},
            'inputs': {'candidate_ref': B.TOOL_BRANCH, 'expected_sha': SOURCE, 'test_parallelism': '4',
                       'commission_singleton_units': '', 'build_only': 'false', 'diagnostics_only': 'true',
                       'controller_only': 'false', 'native_tool_only': 'true'}}


def response(status, headers):
    return SimpleNamespace(status=status, getheaders=lambda: headers)


def owned_result(**changes):
    return {'reaped': True, 'groupQuiescent': True, 'admitted': True, 'reason': 'complete',
            'commandExit': 0, 'escapedSession': False} | changes


class ToolIntentModels(unittest.TestCase):
    def test_only_exact_real_native_job_and_manual_self_source_enter(self):
        self.assertEqual(B.tool_intent(environment(), event())[0], '123')
        for key, value in [('GITHUB_JOB','runner-diagnostics'), ('GITHUB_RUN_ATTEMPT','2'),
                           ('RUNNER_ENVIRONMENT','self-hosted'), ('GITHUB_EVENT_NAME','push'),
                           ('GITHUB_REF','refs/heads/main'), ('GITHUB_WORKFLOW_SHA','b'*40),
                           ('AIHR_CI_HEAD','b'*40), ('GITHUB_WORKFLOW_REF','StradaverseHub/ai-hr/.github/workflows/other.yml@'+REF)]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                B.tool_intent(environment() | {key:value}, event())

    def test_foreign_event_and_incompatible_modes_refuse_before_acquisition(self):
        for key, value in [('expected_sha','b'*40), ('candidate_ref','alpha'), ('test_parallelism','8'),
                           ('commission_singleton_units','["db-d183149d346e757b"]'), ('build_only','true'),
                           ('diagnostics_only','false'), ('controller_only','true'), ('native_tool_only','false'),
                           ('command','fictional')]:
            data = event()
            data['inputs'][key] = value
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'Exclusive fixed TOOL'):
                B.tool_intent(environment(), data)
        data = event()
        data['repository']['id'] = 5
        with self.assertRaisesRegex(ValueError, 'Original TOOL dispatch'):
            B.tool_intent(environment(), data)

    def test_tool_capsule_binds_fixed_package_metadata_and_actual_git_blob_shape(self):
        root = pathlib.Path(__file__).resolve().parents[2]
        for path in B.TOOL_PACKAGE_PINS:
            raw = (root / path).read_bytes()
            info = (root / path).lstat()
            self.assertEqual(B._tool_row(path, raw, info)['sha256'], B.TOOL_PACKAGE_PINS[path])
            with self.assertRaisesRegex(ValueError, 'Pinned TOOL package metadata'):
                B._tool_row(path, raw + b'\n', info)
        self.assertEqual(len(B.TOOL_MEMBERS), 8)
        self.assertEqual(len(set(B.TOOL_MEMBERS)), 8)
        self.assertIn(B.TOOL_SOURCE, B.TOOL_MEMBERS)
        self.assertNotIn('node_modules', B.TOOL_MEMBERS)


class ToolTransportModels(unittest.TestCase):
    def test_exact_generation_and_length_and_fixed_npm_http_framing(self):
        headers = [('Content-Length',str(C.BROWSER_BYTES)), ('x-goog-generation',C.GENERATION)]
        self.assertEqual(C._download_headers(response(200, headers), C.BROWSER_BYTES, True), C.BROWSER_BYTES)
        self.assertEqual(C._download_headers(response(200, [('content-length','45')]), C.NPM_MAX, False), 45)
        self.assertIsNone(C._download_headers(response(200, [('transfer-encoding','chunked')]), C.NPM_MAX, False))
        self.assertEqual(len(C.DOWNLOADS), 4)
        self.assertEqual({host for _, host, _, _ in C.DOWNLOADS}, {'storage.googleapis.com','registry.npmjs.org'})

    def test_redirect_partial_encoding_duplicate_and_wrong_generation_refuse(self):
        exact = [('Content-Length',str(C.BROWSER_BYTES)), ('x-goog-generation',C.GENERATION)]
        variants = [(302,exact+[('location','https://foreign.invalid')]), (206,exact),
                    (200,exact+[('content-encoding','gzip')]), (200,exact+[('content-range','bytes 0-2/3')]),
                    (200,exact+[('content-length','17')]), (200,exact+[('transfer-encoding','chunked')]),
                    (200,[('content-length',str(C.BROWSER_BYTES)), ('x-goog-generation','123')]),
                    (200,[('content-length',str(C.BROWSER_BYTES + 1)), ('x-goog-generation',C.GENERATION)])]
        for status, headers in variants:
            with self.subTest(status=status, headers=headers), self.assertRaises(ValueError):
                C._download_headers(response(status, headers), C.BROWSER_BYTES, True)

    def test_actual_owned_process_summary_and_absolute_reserve_gate_success(self):
        start = 1000
        course = C.Course('123', 1001, 1001, start)
        kernel = Mock()
        kernel.supervise.return_value = owned_result()
        kernel.own_children.return_value = []
        course.kernel = kernel
        argv = ['/usr/bin/python3', '-I', '-B', '/fixed-source']
        with patch.object(C.time, 'monotonic', return_value=start + 140), patch.object(C, 'quiet_command_stdio', nullcontext):
            course.command(argv, course.active, 150)
        self.assertEqual(kernel.supervise.call_args.args[:2], (argv, 4))
        self.assertTrue(course.processes_settled)
        kernel.supervise.reset_mock()
        with patch.object(C.time, 'monotonic', return_value=start + 144), patch.object(C, 'quiet_command_stdio', nullcontext), \
             self.assertRaisesRegex(ValueError, 'settlement reserve'):
            course.command(argv, course.active, 150)
        kernel.supervise.assert_not_called()

    def test_unreaped_or_still_live_child_never_permits_owned_disposal(self):
        start = time.monotonic()
        for result, children in [(owned_result(reaped=False), []), (owned_result(), [700])]:
            course = C.Course('123', 1001, 1001, start)
            course.kernel = Mock()
            course.kernel.supervise.return_value = result
            course.kernel.own_children.return_value = children
            with self.subTest(result=result, children=children), patch.object(C, 'quiet_command_stdio', nullcontext), \
                 self.assertRaisesRegex(ValueError, 'owned command'):
                course.command(['/fixed'], course.active, 10)
            self.assertFalse(course.processes_settled)
            with self.assertRaisesRegex(ValueError, 'ownership uncertain'):
                course.dispose_mounts()
            with self.assertRaisesRegex(ValueError, 'requires native mount'):
                course.dispose_tree({})


class ToolDisposalModels(unittest.TestCase):
    def test_foreign_or_replaced_mount_never_triggers_unmount(self):
        for mount in [(32, 'payload'), (31, 'payload/foreign')]:
            course = C.Course('123', 1001, 1001, time.monotonic())
            course.owned_mount = 31
            course.check_root = Mock()
            course.observe_mounts = Mock(return_value=[{'id':mount[0], 'target':str(course.path / mount[1])}])
            course.command = Mock()
            with self.subTest(mount=mount), self.assertRaisesRegex(ValueError, 'owned mount changed'):
                course.dispose_mounts()
            course.command.assert_not_called()
            self.assertNotIn('mountsAbsent', course.state)

    def test_observed_owned_mount_and_real_absence_are_both_required(self):
        course = C.Course('123', 1001, 1001, time.monotonic())
        course.owned_mount = 31
        course.check_root = Mock()
        observed = {'id':31, 'target':str(course.path / 'payload')}
        course.payload_mount = Mock(return_value=observed)
        course.observe_mounts = Mock(side_effect=[[observed], []])
        course.command = Mock()
        course.dispose_mounts()
        course.command.assert_called_once_with([C.UMOUNT,'-i','--',observed['target']], course.deadline, 10)
        self.assertTrue(course.state['mountsAbsent'])
        course.state.clear()
        course.observe_mounts = Mock(side_effect=[[observed], [observed]])
        with self.assertRaisesRegex(ValueError, 'owned mount still live'):
            course.dispose_mounts()
        self.assertNotIn('mountsAbsent', course.state)

    def test_primary_operation_failure_survives_later_owned_settlement_refusal(self):
        course = C.Course('123', 1001, 1001, time.monotonic())
        called = Mock()

        def acquired(_parent):
            course.created = True

        course.create = acquired
        course.install_capsule = called.install
        course.enter_private_mount_namespace = called.namespace
        course.acquire = Mock(side_effect=ValueError('fictional original failure'))
        course.dispose_mounts = called.mounts
        course.dispose_tree = called.tree
        called.tree.side_effect = ValueError('fictional cleanup failure')
        self.assertEqual(course.execute(123, {}), ('fixed-archive-acquisition','refused'))
        self.assertEqual(called.mock_calls, [call.install({}),call.namespace(),call.mounts(),call.tree({})])

    def test_complete_requires_both_actual_absence_facts_and_live_absolute_boundary(self):
        start = time.monotonic()
        course = C.Course('123', 1001, 1001, start)
        course.state.update(transfer={'generation':C.GENERATION, 'lengths':dict.fromkeys(C.ARCHIVES, 1)},
                            materialized={'readOnly':True, 'noExec':True, 'entries':1}, mountsAbsent=True)
        self.assertFalse(C.course_complete(course, None, 'complete', start + 1))
        course.state['namespaceAbsent'] = True
        self.assertTrue(C.course_complete(course, None, 'complete', start + 1))
        self.assertFalse(C.course_complete(course, 'strict-materialization', 'complete', start + 1))
        self.assertFalse(C.course_complete(course, None, 'refused', start + 1))
        self.assertFalse(C.course_complete(course, None, 'complete', start + 180))
        course.processes_settled = False
        self.assertFalse(C.course_complete(course, None, 'complete', start + 1))


if __name__ == '__main__':
    unittest.main()
