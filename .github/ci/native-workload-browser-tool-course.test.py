"""Source models for the exclusive TOOL route. No network, sudo or native mount."""
from __future__ import annotations

import copy
import fcntl
import io
import os
import pathlib
import runpy
import signal
import stat
import sys
import tempfile
import time
import unittest
from contextlib import ExitStack, nullcontext
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


def tool_owner_report():
    # Fictional receipt data with the exact producer shape. The capture gate
    # checks publication shape and neither authenticates nor grants authority.
    rows = [{'path':path, 'mode':'100644', 'size':100, 'gitBlob':'b'*40,
             'sha256':B.TOOL_PACKAGE_PINS.get(path, 'c'*64)} for path in B.TOOL_MEMBERS]
    packages = ('playwright','playwright-core','postgres')
    outcome = {'reason':'complete', 'exit':0, 'admitted':True, 'reaped':True, 'quiescent':True, 'escapedSession':False}
    return {'kind':'NATIVE_TOOL_ONLY_COMPONENT', 'complete':True, 'cleanup':'complete', 'source':SOURCE,
            'controller':SOURCE, 'runId':'123', 'attempt':1, 'job':'native-test', 'eventSha256':'e'*64,
            'sourceMembers':rows, 'sourceCapsuleSha256':B.hashlib.sha256(B.canonical(rows)).hexdigest(),
            'platform':{'system':'linux', 'machine':'x86_64', 'ubuntu':'24.04', 'python':[3,12,3]},
            'elapsedMs':100000, 'ownedProcessesSettled':True, 'browserStarted':False, 'applicationBuilt':False,
            'databaseStarted':False, 'nativeWorkloadQualified':False, 'releaseAuthorized':False,
            'processOutcomes':{operation:outcome.copy() for operation in
                               ('namespace-private','archive-downloader','payload-bind','payload-remount','payload-unmount')},
            'transfer':{'generation':'1784092784777971', 'privateWriters':True,
                        'lengths':{'chromium.zip':120231126, **{name+'.tgz':1 for name in packages}}},
            'materialized':{'treeSha256':'1'*64, 'browserSha256':'2'*64, 'browserTreeSha256':'3'*64,
                            'readOnly':True, 'noSuid':True, 'noDev':True, 'noExec':True, 'entries':300,
                            'fileBytes':273378828, 'mountId':22, 'packageLockSRI':dict.fromkeys(packages,'sha512-'+'A'*86+'==')},
            'mountsAbsent':True, 'namespaceAbsent':True}


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

    def test_receiver_requires_bounded_seekable_and_exactly_sealed_transport(self):
        flags = os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING
        seals = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL
        with C.owned_fd(os.memfd_create('tool-model', flags)) as fd:
            raw = B.canonical({'fictional': True})
            os.write(fd, raw)
            os.lseek(fd, 0, os.SEEK_SET)
            fcntl.fcntl(fd, fcntl.F_ADD_SEALS, fcntl.F_SEAL_WRITE)
            with self.assertRaises(ValueError):
                B._tool_request(fd)
            fcntl.fcntl(fd, fcntl.F_ADD_SEALS, seals)
            self.assertEqual(B._tool_request(fd), {'fictional': True})
            with self.assertRaises(ValueError):
                B._tool_request(fd)
        with tempfile.TemporaryFile() as regular:
            regular.write(raw)
            regular.seek(0)
            with self.assertRaises((OSError, ValueError)):
                B._tool_request(regular.fileno())
        reader, writer = os.pipe()
        with C.owned_fd(reader), C.owned_fd(writer), self.assertRaises(ValueError):
            B._tool_request(reader)

    def test_returned_pre_root_refusal_is_bounded_and_kill_or_partial_is_not_a_receipt(self):
        stdout = SimpleNamespace(buffer=io.BytesIO())
        path = str(pathlib.Path(__file__).with_name('native-controller-bootstrap.py'))
        with patch.object(sys, 'argv', [path, '--tool-only']), patch.object(sys, 'stdout', stdout), \
             patch.dict(os.environ, clear=True), self.assertRaises(SystemExit) as exited:
            runpy.run_path(path, run_name='__main__')
        self.assertEqual(exited.exception.code, 1)
        raw = stdout.buffer.getvalue()
        self.assertEqual(raw, B.canonical({'kind':'NATIVE_TOOL_ONLY_COMPONENT', 'complete':False,
                                           'failure':'tool-pre-root-refused', 'cleanup':'not-observed',
                                           'releaseAuthorized':False}))
        B._validate_tool_capture(raw, '1')
        for malformed, status in [(raw, '0'), (raw, '137'), (b'', '1'), (raw[:-1], '1'), (raw[:-4], '1')]:
            with self.subTest(status=status), self.assertRaises(ValueError):
                B._validate_tool_capture(malformed, status)

    def test_success_capture_requires_closed_owner_shape_and_positive_settlement(self):
        report = tool_owner_report()
        B._validate_tool_capture(B.canonical(report), '0')
        bare = {'kind':'NATIVE_TOOL_ONLY_COMPONENT', 'complete':True, 'releaseAuthorized':False}
        with self.assertRaises(ValueError):
            B._validate_tool_capture(B.canonical(bare), '0')
        for change in (lambda row: row.update(extra='foreign value'), lambda row: row.pop('mountsAbsent'),
                       lambda row: row.update(attempt=True), lambda row: row.update(controller='b'*40),
                       lambda row: row.update(elapsedMs=180000), lambda row: row['sourceMembers'].reverse(),
                       lambda row: row['sourceMembers'][0].update(size=True),
                       lambda row: row['sourceMembers'][0].update(raw='foreign value'),
                       lambda row: row['sourceMembers'][0].update(gitBlob='d'*40),
                       lambda row: row['platform'].update(python=[3,12,True]),
                       lambda row: row['transfer']['lengths'].update({'postgres.tgz':16*1024**2+1}),
                       lambda row: row['materialized']['packageLockSRI'].update(postgres='sha512-foreign'),
                       lambda row: row['processOutcomes'].pop('payload-unmount'),
                       lambda row: row['processOutcomes']['archive-downloader'].update(exit=False)):
            changed = copy.deepcopy(report)
            change(changed)
            with self.subTest(fields=changed.keys()), self.assertRaises(ValueError):
                B._validate_tool_capture(B.canonical(changed), '0')

    def test_refusal_capture_closes_unknown_and_positive_cleanup_shapes_separately(self):
        early = B._tool_refusal('tool-bootstrap-refused')
        B._validate_tool_capture(B.canonical(early), '1')
        with self.assertRaises(ValueError):
            B._validate_tool_capture(B.canonical(early | {'cleanup':'complete'}), '1')
        with self.assertRaises(ValueError):
            B._validate_tool_capture(B.canonical(early | {'extra':'unbounded'}), '1')
        report = tool_owner_report()
        report.update(complete=False, cleanup='refused', failure='fixed-archive-acquisition',
                      failureReason='deadline', cleanupReason='contract-refused', ownedProcessesSettled=False)
        for key in ('transfer','materialized','mountsAbsent','namespaceAbsent'):
            del report[key]
        outcomes = report['processOutcomes']
        outcomes['archive-downloader'].update(exit=None, reason='deadline', reaped=False, quiescent=False,
                                               settlementReason='group-uncertain')
        for operation in ('payload-bind','payload-remount','payload-unmount'):
            del outcomes[operation]
        B._validate_tool_capture(B.canonical(report), '1')
        for changed in (report | {'cleanup':'complete'}, report | {'cleanupReason':'unknown raw text'},
                        report | {'mountsAbsent':True}, report | {'failureReason':'raw error'}):
            with self.assertRaises(ValueError):
                B._validate_tool_capture(B.canonical(changed), '1')
        report.update(cleanup='complete', ownedProcessesSettled=True, mountsAbsent=True, namespaceAbsent=True)
        del report['cleanupReason']
        row = outcomes['archive-downloader']
        row.update(exit=-9, reaped=True, quiescent=True)
        del row['settlementReason']
        B._validate_tool_capture(B.canonical(report), '1')


class ToolTransportModels(unittest.TestCase):
    def test_incomplete_and_overcap_bodies_are_framing_refusals_before_overcap_write(self):
        now = time.monotonic()
        for headers, pieces, written, success in [
            ([('Content-Length','3')], [b'abc',b''], 3, True),
            ([('Content-Length','3')], [b'a',b''], 1, False),
            ([('Content-Length','3')], [b'abcd'], 0, False),
            ([('Transfer-Encoding','chunked')], [b'abcd',b'e'], 4, False),
            ([('Transfer-Encoding','chunked')], [C.http.client.IncompleteRead(b'a',2)], 0, False),
        ]:
            observed = response(200, headers)
            observed.read = Mock(side_effect=pieces)
            with self.subTest(headers=headers,pieces=pieces), patch.object(C, 'write_all') as write:
                if success:
                    self.assertEqual(C._download_body(observed, 17, 4, False, now+30), 3)
                    write.assert_called_once_with(17,b'abc',now+30)
                else:
                    with self.assertRaises(C.ToolRefusal) as refused:
                        C._download_body(observed, 17, 4, False, now+30)
                    self.assertEqual(refused.exception.reason, 'download-framing')
                self.assertEqual(sum(len(step.args[1]) for step in write.call_args_list), written)

    def test_writer_capabilities_require_five_fresh_disjoint_write_only_inodes(self):
        with tempfile.TemporaryDirectory() as parent, ExitStack() as held:
            paths = [pathlib.Path(parent) / name for name in C.DOWNLOAD_SLOTS]
            writers = [held.enter_context(C.owned_fd(os.open(path, C.WRITE, 0o600))) for path in paths]
            reader = held.enter_context(C.owned_fd(os.open(paths[-1], C.READ)))
            fstat = os.fstat

            def root_metadata(fd):
                info = fstat(fd)
                return SimpleNamespace(st_uid=0, st_gid=0, **{field:getattr(info, field) for field in
                                       ('st_dev','st_ino','st_mode','st_nlink','st_size','st_mtime_ns','st_ctime_ns')})

            with patch.object(C.os, 'fstat', side_effect=root_metadata):
                C.download_writers(writers)
                for invalid in (writers[:-1], writers[:-1]+[writers[0]], writers[:-1]+[reader]):
                    with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                        C.download_writers(invalid)
                os.write(writers[0], b'partial')
                with self.assertRaises(ValueError):
                    C.download_writers(writers)

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
        kernel.own_children.return_value = []
        course.kernel = kernel
        argv = [C.MOUNT, '-i', '--make-rprivate', '/']
        with patch.object(C.time, 'monotonic', return_value=start + 140), patch.object(C, 'quiet_command_stdio', nullcontext), \
             patch.object(C, '_run_tool_command', return_value=owned_result()) as run:
            course.command(argv, course.active, 10)
        run.assert_called_once_with(kernel, argv, start + 144)
        self.assertTrue(course.processes_settled)
        course = C.Course('123', 1001, 1001, start)
        course.kernel = kernel
        with patch.object(C.time, 'monotonic', return_value=start + 144), patch.object(C, 'quiet_command_stdio', nullcontext), \
             patch.object(C, '_run_tool_command') as run, \
             self.assertRaisesRegex(ValueError, 'settlement reserve'):
            course.command(argv, course.active, 10)
        run.assert_not_called()

    def test_unreaped_or_still_live_child_never_permits_owned_disposal(self):
        start = time.monotonic()
        for result, children in [(owned_result(reaped=False), []), (owned_result(), [700])]:
            course = C.Course('123', 1001, 1001, start)
            course.kernel = Mock()
            course.kernel.own_children.return_value = children
            with self.subTest(result=result, children=children), patch.object(C, 'quiet_command_stdio', nullcontext), \
                 patch.object(C, '_run_tool_command', return_value=result), \
                 self.assertRaisesRegex(ValueError, 'owned command'):
                course.command([C.MOUNT, '-i', '--make-rprivate', '/'], course.active, 10)
            self.assertFalse(course.processes_settled)
            with self.assertRaisesRegex(ValueError, 'ownership uncertain'):
                course.dispose_mounts()
            with self.assertRaisesRegex(ValueError, 'requires native mount'):
                course.dispose_tree({})

    def test_setup_consumes_absolute_stop_before_ack_and_settles_with_original_reserve(self):
        now = 107
        child = 4321
        kernel = Mock()
        kernel.own_children.side_effect = [[], [child], []]
        kernel.live_group.return_value = []

        def pidfd_open(pid):
            nonlocal now
            self.assertEqual(pid, child)
            now = 110
            return 20

        with patch.object(C.time, 'monotonic', side_effect=lambda: now), \
             patch.object(C.pathlib.Path, 'iterdir', return_value=iter([1])), \
             patch.object(C.signal, 'getsignal', return_value=signal.SIG_DFL), patch.object(C.signal, 'signal'), \
             patch.object(C.os, 'pipe', side_effect=[(10,11),(12,13)]), patch.object(C.os, 'close'), \
             patch.object(C.os, 'fork', return_value=child), patch.object(C.os, 'pidfd_open', side_effect=pidfd_open), \
             patch.object(C.os, 'waitid', return_value=SimpleNamespace(si_pid=child)) as observed, \
             patch.object(C.os, 'waitpid', return_value=(child, 0)) as waited, \
             patch.object(C.os, 'write') as ack, patch.object(C.signal, 'pidfd_send_signal') as terminate:
            result = C._run_tool_command(kernel, [C.MOUNT,'-i','--make-rprivate','/'], 110)
        ack.assert_not_called()
        terminate.assert_called_once_with(20, signal.SIGKILL)
        observed.assert_called_with(os.P_PID, child, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        waited.assert_called_once_with(child, os.WNOHANG)
        self.assertEqual(result, owned_result(admitted=False, reason='handshake-refused', commandExit=None))

    def test_ready_identity_readback_at_active_edge_never_acknowledges(self):
        child, now = 4321, 109
        row = {'pid':child, 'parent':os.getpid(), 'group':child, 'session':child, 'start':22, 'state':'S'}
        packet = C.canonical({'kind':'ready', **{key:value for key, value in row.items() if key != 'state'}})
        kernel = Mock()

        def identity(_pid):
            nonlocal now
            now = 110
            return row

        kernel.identity.side_effect = identity
        with patch.object(C.time, 'monotonic', side_effect=lambda: now), \
             patch.object(C.select, 'select', return_value=([10], [], [])), patch.object(C.os, 'read', return_value=packet), \
             patch.object(C.os, 'write') as ack, self.assertRaisesRegex(C.ToolRefusal, 'elapsed boundary'):
            C._admit_tool_command(kernel, child, 10, 13, 110, lambda: False)
        ack.assert_not_called()

    def test_child_refuses_late_ack_at_shorter_handshake_stop_before_native_exec(self):
        for granted_at in (102.5, 103):
            now = 100
            kernel = Mock()
            kernel.own_children.return_value = []
            kernel.identity.return_value = {'pid':4321, 'parent':1234, 'group':4321, 'session':4321, 'start':22, 'state':'S'}

            def grant(_fd, _length):
                nonlocal now
                now = granted_at
                return b'A'

            with self.subTest(granted_at=granted_at), patch.object(C.time, 'monotonic', side_effect=lambda: now), \
                 patch.object(C.pathlib.Path, 'iterdir', return_value=iter([1])), \
                 patch.object(C.signal, 'getsignal', return_value=signal.SIG_DFL), patch.object(C.signal, 'signal'), \
                 patch.object(C.os, 'pipe', side_effect=[(10,11),(12,13)]), patch.object(C.os, 'close'), \
                 patch.object(C.os, 'fork', return_value=0), patch.object(C.os, 'setsid'), \
                 patch.object(C.os, 'read', side_effect=grant), patch.object(C.os, '_exit', side_effect=SystemExit(125)), \
                 patch.object(C.os, 'execve', side_effect=OSError('fictional')) as execute, self.assertRaises(SystemExit):
                C._run_tool_command(kernel, [C.MOUNT,'-i','--make-rprivate','/'], 110)
            self.assertEqual(execute.call_count, int(granted_at < 103))

    def test_late_written_ack_keeps_real_group_proof_through_owned_refusal_reap(self):
        child, now = 4321, 100
        row = {'pid':child, 'parent':os.getpid(), 'group':child, 'session':child, 'start':22, 'state':'S'}
        packet = C.canonical({'kind':'ready', **{key:value for key, value in row.items() if key != 'state'}})
        kernel = Mock()
        kernel.own_children.side_effect = [[], [child], []]
        kernel.identity.return_value = row
        kernel.live_group.return_value = []

        def write_ack(fd, data):
            nonlocal now
            self.assertEqual((fd,data), (13,b'A'))
            now = 103
            return 1

        with patch.object(C.time, 'monotonic', side_effect=lambda: now), \
             patch.object(C.pathlib.Path, 'iterdir', return_value=iter([1])), \
             patch.object(C.signal, 'getsignal', return_value=signal.SIG_DFL), patch.object(C.signal, 'signal'), \
             patch.object(C.os, 'pipe', side_effect=[(10,11),(12,13)]), patch.object(C.os, 'close'), \
             patch.object(C.os, 'fork', return_value=child), patch.object(C.os, 'pidfd_open', return_value=20), \
             patch.object(C.select, 'select', return_value=([10], [], [])), patch.object(C.os, 'read', return_value=packet), \
             patch.object(C.os, 'write', side_effect=write_ack), \
             patch.object(C.os, 'waitid', return_value=SimpleNamespace(si_pid=child)), \
             patch.object(C.os, 'killpg') as stop, patch.object(C.os, 'waitpid', return_value=(child,125<<8)) as reap:
            order = Mock()
            order.attach_mock(stop, 'stop')
            order.attach_mock(reap, 'reap')
            result = C._run_tool_command(kernel, [C.MOUNT,'-i','--make-rprivate','/'], 110)
        self.assertEqual(order.mock_calls, [call.stop(child,signal.SIGKILL),call.reap(child,os.WNOHANG)])
        self.assertEqual(result, owned_result(reason='command-failed',commandExit=125))

    def test_absolute_settlement_bound_refuses_late_signal_or_late_reap(self):
        child = 4321
        kernel = Mock()
        kernel.own_children.return_value = [child]
        kernel.live_group.return_value = []
        with patch.object(C.time, 'monotonic', return_value=113), patch.object(C.signal, 'pidfd_send_signal') as stop, \
             patch.object(C.os, 'waitpid') as waited, self.assertRaises(C.ToolRefusal):
            C._stop_tool_command(kernel, child, 20, None, 113, 116)
        stop.assert_not_called()
        waited.assert_not_called()

        now = 110

        def scan(_pid):
            nonlocal now
            if kernel.live_group.call_count == 2:
                now = 116
            return []

        kernel.live_group.side_effect = scan
        with patch.object(C.time, 'monotonic', side_effect=lambda: now), patch.object(C.signal, 'pidfd_send_signal') as stop, \
             patch.object(C.os, 'waitid', return_value=SimpleNamespace(si_pid=child)), patch.object(C.os, 'waitpid') as waited, \
             self.assertRaises(C.ToolRefusal):
            C._stop_tool_command(kernel, child, 20, None, 113, 116)
        stop.assert_called_once_with(20, signal.SIGKILL)
        waited.assert_not_called()

    def test_duplicate_or_foreign_adoption_census_cannot_signal_or_reap_foreign_pid(self):
        child, foreign = 4321, 5432
        for owned in ([child, foreign, foreign], [child, foreign]):
            kernel = Mock()
            kernel.own_children.return_value = owned
            kernel.live_group.return_value = []
            kernel.identity.return_value = {'pid':foreign, 'parent':os.getpid()+1}
            with self.subTest(owned=owned), patch.object(C.time, 'monotonic', return_value=110), \
                 patch.object(C.os, 'waitid', return_value=SimpleNamespace(si_pid=child)), \
                 patch.object(C.signal, 'pidfd_send_signal') as stop, patch.object(C.os, 'pidfd_open') as bind, \
                 patch.object(C.os, 'waitpid') as waited, self.assertRaisesRegex(ValueError, 'adopted process'):
                C._stop_tool_command(kernel, child, 20, None, 113, 116)
            stop.assert_called_once_with(20, signal.SIGKILL)
            bind.assert_not_called()
            waited.assert_not_called()


class ToolDisposalModels(unittest.TestCase):
    def test_partial_precreated_slot_can_be_reclaimed_but_same_name_replacement_is_preserved(self):
        def root_metadata(info):
            fields = ('st_dev','st_ino','st_mode','st_nlink','st_size','st_mtime_ns','st_ctime_ns')
            return SimpleNamespace(st_uid=0, st_gid=0, **{field:getattr(info, field) for field in fields})

        for replace in (False, True):
            course = C.Course('123', 1001, 1001, time.monotonic())
            course.check_root = Mock()
            course.state['mountsAbsent'] = True
            with self.subTest(replace=replace), tempfile.TemporaryDirectory() as parent:
                root = pathlib.Path(parent) / course.name
                root.mkdir(mode=0o700)
                incoming = root / 'incoming'
                incoming.mkdir(mode=0o700)
                archive = incoming / C.DOWNLOAD_SLOTS[0]
                with C.owned_fd(os.open(parent, C.DIR)) as outer, C.owned_fd(os.open(root, C.DIR)) as held, \
                     C.owned_fd(os.open(archive, C.WRITE, 0o600)) as writer:
                    os.write(writer, b'partial')
                    course.parent, course.root = outer, held
                    course.device = root.stat().st_dev
                    course.births = {'': C.birth(root.stat()), 'incoming': C.birth(incoming.stat())}
                    course.download_births[archive.name] = C.birth(os.fstat(writer))
                    if replace:
                        archive.unlink()
                        with C.owned_fd(os.open(archive, C.WRITE, 0o600)) as substitute:
                            os.write(substitute, b'foreign')
                    original_named, original_fstat = C.named, os.fstat
                    with patch.object(C, 'named', side_effect=lambda *args: root_metadata(original_named(*args))), \
                         patch.object(C.os, 'fstat', side_effect=lambda fd: root_metadata(original_fstat(fd))):
                        if replace:
                            with self.assertRaisesRegex(ValueError, 'unowned disposal entry'):
                                course.dispose_tree({})
                            self.assertEqual(archive.read_bytes(), b'foreign')
                            self.assertNotIn('namespaceAbsent', course.state)
                        else:
                            course.dispose_tree({})
                            self.assertFalse(root.exists())
                            self.assertTrue(course.state['namespaceAbsent'])

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
        course.acquire = Mock(side_effect=C.ToolRefusal('fictional original failure','download-framing'))
        course.dispose_mounts = called.mounts
        course.dispose_tree = called.tree
        called.tree.side_effect = ValueError('fictional cleanup failure')
        self.assertEqual(course.execute(123, {}), ('fixed-archive-acquisition','refused'))
        self.assertEqual(called.mock_calls, [call.install({}),call.namespace(),call.mounts(),call.tree({})])
        self.assertEqual(course.state['failureReason'], 'download-framing')
        self.assertEqual(course.state['cleanupReason'], 'contract-refused')
        self.assertNotIn('fictional', repr(course.state))

    def test_complete_requires_both_actual_absence_facts_and_live_absolute_boundary(self):
        start = time.monotonic()
        course = C.Course('123', 1001, 1001, start)
        course.state.update(transfer={'generation':C.GENERATION, 'lengths':dict.fromkeys(C.ARCHIVES, 1), 'privateWriters':True},
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
