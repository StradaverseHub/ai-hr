"""Source models for the exclusive TOOL route. No network, sudo or native mount."""
from __future__ import annotations

import copy
import fcntl
import io
import os
import pathlib
import runpy
import signal
import socket
import stat
import sys
import tempfile
import time
import unittest
from contextlib import ExitStack, nullcontext
from types import ModuleType, SimpleNamespace
from unittest.mock import MagicMock, Mock, call, patch


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
        env = environment()
        for omitted in (False, True):
            data = event()
            if omitted:
                del data['inputs']['commission_singleton_units']
            with self.subTest(omitted=omitted):
                raw = B.canonical(data)
                self.assertEqual(B.tool_intent(env, data), ('123', pathlib.Path(env['GITHUB_WORKSPACE'])))
                self.assertEqual(B.canonical(data), raw)
                event_row = {'path':'/home/runner/work/_temp/_github_workflow/event.json',
                             'size':len(raw), 'sha256':B.hashlib.sha256(raw).hexdigest()}
                request = {'environment':env, 'runnerUid':1001, 'runnerGid':1001, 'event':event_row, 'rows':[]}
                # The receiver must accept the same original event bytes, then refuse the empty capsule.
                with patch.object(sys, 'platform', 'linux'), patch.object(os, 'geteuid', return_value=0), \
                     patch.dict(os.environ, {'SUDO_UID':'1001','SUDO_GID':'1001'}, clear=True), \
                     patch.object(B.pwd, 'getpwuid', return_value=SimpleNamespace(pw_gid=1001)), \
                     patch.object(B, '_tool_event', return_value=raw) as read_event, \
                     self.assertRaisesRegex(ValueError, 'Fixed TOOL capsule census required'):
                    B.seal_tool(request)
                read_event.assert_called_once_with(env, event_row['path'], 1001, event_row)
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
        identity = {key:Mock(return_value=1001) for key in ('getuid', 'geteuid', 'getgid', 'getegid')}
        with patch.object(sys, 'platform', 'linux'), patch.multiple(os, **identity):
            with patch.object(sys, 'argv', [path, '--tool-only']), patch.object(sys, 'stdout', stdout), \
                 patch.dict(os.environ, clear=True), self.assertRaises(SystemExit) as exited:
                runpy.run_path(path, run_name='__main__')
            env = environment() | {'GITHUB_EVENT_PATH':'/home/runner/work/_temp/_github_workflow/event.json'}
            base = {'kind':'NATIVE_TOOL_ONLY_COMPONENT', 'complete':False, 'failure':'tool-pre-root-refused',
                    'cleanup':'not-observed', 'releaseAuthorized':False}
            dispatch = event()
            inputs = dispatch['inputs']
            omitted = {key:value for key, value in inputs.items() if key != 'commission_singleton_units'}
            typed = {'build_only':False, 'diagnostics_only':True, 'controller_only':False, 'native_tool_only':True}
            payload = B.canonical(dispatch)
            cases = [
                (OSError('fictional private path'), {}, 'event-file'),
                (b'{fictional private bytes', {}, 'event-json'),
                (payload, {'GITHUB_REF_NAME':'main'}, 'dispatch-runner-ref'),
                (payload, {'GITHUB_WORKFLOW_SHA':'b'*40}, 'dispatch-runner-source'),
                (payload, {'GITHUB_WORKFLOW_REF':env['GITHUB_WORKFLOW_REF'].replace(REF, 'refs/heads/main')},
                 'dispatch-runner-workflow'),
                (B.canonical(dispatch | {'repository':{'id':5, 'full_name':'StradaverseHub/ai-hr'}}), {},
                 'dispatch-event-repository'),
                (B.canonical(dispatch | {'ref':'refs/heads/main'}), {}, 'dispatch-event-ref'),
            ]
            for actual, checkpoint in (([], 'dispatch-input-map'), ({}, 'dispatch-input-keys'),
                                       (inputs | {'extra':'fictional private bytes'}, 'dispatch-input-keys'),
                                       (omitted | {'extra':'fictional private bytes'}, 'dispatch-input-keys'),
                                       ({key:value for key, value in omitted.items() if key != 'expected_sha'}, 'dispatch-input-keys'),
                                       (inputs | {'test_parallelism':'8'}, 'dispatch-input-values'),
                                       (omitted | {'test_parallelism':'8'}, 'dispatch-input-values'),
                                       (inputs | {'commission_singleton_units':' '}, 'dispatch-input-values'),
                                       (inputs | {'commission_singleton_units':None}, 'dispatch-input-types'),
                                       (inputs | {'commission_singleton_units':False}, 'dispatch-input-types'),
                                       (inputs | typed | {'controller_only':True}, 'dispatch-input-types'),
                                       (inputs | typed, 'dispatch-typed-booleans'),
                                       (omitted | typed, 'dispatch-commission-omitted-and-typed-booleans')):
                cases.append((B.canonical(dispatch | {'inputs':actual}), {}, checkpoint))
            for supplied, environment_changes, checkpoint in cases:
                with self.subTest(checkpoint=checkpoint), patch.dict(os.environ, env | environment_changes, clear=True), \
                     patch.object(B, '_tool_event', side_effect=[supplied]):
                    receipt = B.prepare_tool()
                    self.assertEqual(receipt, base | {'preRootCheckpoint':checkpoint})
                    B._validate_tool_capture(B.canonical(receipt), '1')
            for actual in (inputs, omitted):
                with self.subTest(commission_present='commission_singleton_units' in actual), \
                     patch.dict(os.environ, env, clear=True), \
                     patch.object(B, '_tool_event', return_value=B.canonical(dispatch | {'inputs':actual})), \
                     patch.object(pathlib.Path, 'cwd', return_value=pathlib.Path('/fictional-tool-controller')):
                    receipt = B.prepare_tool()
                    self.assertEqual(receipt, base | {'preRootCheckpoint':'controller-location'})
                    B._validate_tool_capture(B.canonical(receipt), '1')
            with patch.dict(os.environ, env, clear=True), patch.object(B, '_tool_event', return_value=payload), \
                 patch.object(B, 'context', side_effect=[('123', pathlib.Path(env['GITHUB_WORKSPACE'])),
                                                        OSError('fictional private second context error')]):
                receipt = B.prepare_tool()
                self.assertEqual(receipt, base | {'preRootCheckpoint':'dispatch-runner-context'})
                B._validate_tool_capture(B.canonical(receipt), '1')
        self.assertEqual(exited.exception.code, 1)
        raw = stdout.buffer.getvalue()
        self.assertEqual(raw, B.canonical(base | {'preRootCheckpoint':'runner-context'}))
        B._validate_tool_capture(raw, '1')
        for malformed, status in [(raw, '0'), (raw, '137'), (b'', '1'), (raw[:-1], '1'), (raw[:-4], '1')]:
            with self.subTest(status=status), self.assertRaises(ValueError):
                B._validate_tool_capture(malformed, status)
        for changed in (base, base | {'preRootCheckpoint':'fictional private path'},
                        base | {'preRootCheckpoint':['runner-context']},
                        base | {'preRootCheckpoint':'runner-context', 'details':'fictional private value'},
                        base | {'preRootCheckpoint':'runner-context', 'failure':'tool-bootstrap-refused'}):
            with self.subTest(fields=changed.keys()), self.assertRaises(ValueError):
                B._validate_tool_capture(B.canonical(changed), '1')
        B._validate_tool_capture(B.canonical(base | {'preRootCheckpoint':'unknown'}), '1')
        B._validate_tool_capture(B.canonical(base | {'preRootCheckpoint':'dispatch-commission-omitted'}), '1')

    def test_success_capture_requires_closed_owner_shape_and_positive_settlement(self):
        report = tool_owner_report()
        B._validate_tool_capture(B.canonical(report), '0')
        with self.assertRaisesRegex(ValueError, 'writer handoff differs'):
            B._validate_tool_capture(B.canonical(report), '0', live=True)
        for handoff in (*C.DUMP_POLICIES.values(), 'foreign'):
            with self.subTest(handoff=handoff):
                live = report | {'transfer':report['transfer'] | {'writerHandoff':handoff}}
                if handoff == 'foreign':
                    with self.assertRaisesRegex(ValueError, 'writer handoff differs'):
                        B._validate_tool_capture(B.canonical(live), '0', live=True)
                else:
                    B._validate_tool_capture(B.canonical(live), '0', live=True)
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

    def test_owner_capture_refuses_contradictory_process_and_cleanup_claims(self):
        report = tool_owner_report()
        report.update(complete=False, failure='readonly-installation-readback', failureReason='deadline', elapsedMs=179999)
        B._validate_tool_capture(B.canonical(report), '1')

        for unmount in (None, {'reason':'command-failed', 'exit':1, 'admitted':True,
                                'reaped':True, 'quiescent':True, 'escapedSession':False}):
            changed = copy.deepcopy(report)
            outcomes = changed['processOutcomes']
            if unmount is None:
                del outcomes['payload-unmount']
            else:
                outcomes['payload-unmount'] = unmount
            for cleanup in ('complete', 'refused'):
                with self.subTest(unmount=unmount, cleanup=cleanup), self.assertRaisesRegex(ValueError, 'successful owned unmount'):
                    B._validate_tool_capture(B.canonical(changed | {'cleanup':cleanup}), '1')

        readback = copy.deepcopy(report)
        del readback['materialized']
        del readback['namespaceAbsent']
        readback.update(cleanup='refused', cleanupReason='deadline')
        B._validate_tool_capture(B.canonical(readback), '1')
        del readback['processOutcomes']['payload-unmount']
        with self.assertRaisesRegex(ValueError, 'successful owned unmount'):
            B._validate_tool_capture(B.canonical(readback), '1')

        del readback['processOutcomes']['payload-remount']
        readback['processOutcomes']['payload-bind'].update(reason='command-failed', exit=1)
        readback['failureReason'] = 'command-failed'
        B._validate_tool_capture(B.canonical(readback), '1')
        readback['processOutcomes']['payload-unmount'] = readback['processOutcomes']['payload-bind'].copy()
        readback['cleanupReason'] = 'command-failed'
        with self.assertRaisesRegex(ValueError, 'successful owned unmount'):
            B._validate_tool_capture(B.canonical(readback), '1')
        del readback['mountsAbsent']
        B._validate_tool_capture(B.canonical(readback), '1')

        expired = report | {'elapsedMs':180000}
        with self.assertRaisesRegex(ValueError, 'bounded positive closure'):
            B._validate_tool_capture(B.canonical(expired), '1')
        B._validate_tool_capture(B.canonical(expired | {'cleanup':'refused', 'cleanupReason':'deadline'}), '1')

        uncertain = copy.deepcopy(report)
        uncertain.update(failure='fixed-archive-acquisition', failureReason='deadline')
        for key in ('transfer', 'materialized'):
            del uncertain[key]
        outcomes = uncertain['processOutcomes']
        outcomes['archive-downloader'].update(exit=None, reason='deadline', reaped=False, quiescent=False,
                                               settlementReason='group-uncertain')
        for operation in ('payload-bind', 'payload-remount', 'payload-unmount'):
            del outcomes[operation]
        with self.assertRaisesRegex(ValueError, 'cleanup fields differ'):
            B._validate_tool_capture(B.canonical(uncertain), '1')
        for key in ('mountsAbsent', 'namespaceAbsent'):
            del uncertain[key]
        uncertain.update(cleanup='refused', ownedProcessesSettled=False, cleanupReason='contract-refused')
        B._validate_tool_capture(B.canonical(uncertain), '1')

        unacquired = report | {'cleanup':'not-acquired', 'failure':'root-parent-acquisition', 'failureReason':'host-io'}
        for key in ('transfer', 'materialized', 'processOutcomes', 'mountsAbsent', 'namespaceAbsent'):
            del unacquired[key]
        B._validate_tool_capture(B.canonical(unacquired), '1')
        B._validate_tool_capture(B.canonical(unacquired | {'failure':'root-acquisition'}), '1')
        with self.assertRaisesRegex(ValueError, 'unacquired state'):
            B._validate_tool_capture(B.canonical(unacquired | {'ownedProcessesSettled':False}), '1')
        with self.assertRaisesRegex(ValueError, 'unacquired state'):
            B._validate_tool_capture(B.canonical(unacquired | {'failure':'source-capsule'}), '1')


class ToolTransportModels(unittest.TestCase):
    def test_identity_refusals_preserve_order_and_require_zero_after_both_admitted_policies(self):
        empty_caps = b''.join(key + b':\t0000000000000000\n' for key in
                              (b'CapInh', b'CapPrm', b'CapEff', b'CapAmb'))
        status = empty_caps + b'NoNewPrivs:\t1\n'
        steps = [
            ('geteuid', (), 0), ('CDLL', (None,), None),
            ('proc', ('/proc/sys/fs/suid_dumpable', 16), b'0\n'), ('prctl', (4, 0, 0, 0, 0), 0),
            ('setgroups', ([],), None), ('setresgid', (1002,)*3, None), ('setresuid', (1001,)*3, None),
            ('prctl', (3, 0, 0, 0, 0), 0), ('prctl', (4, 0, 0, 0, 0), 0),
            ('prctl', (3, 0, 0, 0, 0), 0), ('prctl', (38, 1, 0, 0, 0), 0),
            ('getresuid', (), (1001,)*3), ('getresgid', (), (1002,)*3), ('getgroups', (), []),
            ('proc', ('/proc/self/status', 65536), status),
        ]
        cases = [
            (0, 1001, 'original'), (2, b'1\n', 'dump-policy'),
            (2, b'fictional private value', 'dump-policy'), (2, OSError('private detail'), 'dump-policy'),
            (3, -1, 'set-dumpable'), (4, OSError('private detail'), 'drop-groups'),
            (5, OSError('private detail'), 'drop-gid'), (6, OSError('private detail'), 'drop-uid'),
            (7, 2, 'post-dumpable'), (8, -1, 'post-dumpable'), (9, 2, 'post-dumpable'),
            (10, -1, 'set-no-new-privs'), (11, (0,)*3, 'post-ids'), (12, (0,)*3, 'post-ids'),
            (13, [1002], 'post-ids'), (14, OSError('private detail'), 'status'),
            (14, status.replace(b'CapEff:\t0', b'CapEff:\t1'), 'capabilities'),
            (14, empty_caps + b'NoNewPrivs:\t0\n', 'observe-no-new-privs'),
            (None, b'0', None), (None, b'2', None),
        ]
        for index, fault, reason in cases:
            observed = []

            def record(name, args):
                position = len(observed)
                expected_name, expected_args, result = steps[position]
                self.assertEqual((name, args), (expected_name, expected_args))
                observed.append(name)
                if position == index:
                    if isinstance(fault, OSError):
                        raise fault
                    return fault
                if index is None and position == 2:
                    return fault + b'\n'
                if index is None and position == 7:
                    return int(fault)
                return result

            libc = SimpleNamespace(prctl=lambda *args: record('prctl', args))

            def load_prctl(*args, use_errno):
                self.assertIs(use_errno, True)
                record('CDLL', args)
                return libc

            with self.subTest(index=index, reason=reason), ExitStack() as mocks:
                for name in ('geteuid','setgroups','setresgid','setresuid','getresuid','getresgid','getgroups'):
                    mocks.enter_context(patch.object(C.os, name, side_effect=lambda *args, name=name: record(name, args)))
                mocks.enter_context(patch.object(C.ctypes, 'CDLL', side_effect=load_prctl))
                mocks.enter_context(patch.object(C, 'bounded_proc', side_effect=lambda *args: record('proc', args)))
                if reason is None:
                    self.assertEqual(C._drop_downloader(1001, 1002), (fault, libc))
                    self.assertEqual(len(observed), len(steps))
                else:
                    with self.assertRaises(C.ToolRefusal) as failure:
                        C._drop_downloader(1001, 1002)
                    self.assertEqual(failure.exception.reason, 'download-identity-' + reason)
                    self.assertEqual(str(failure.exception), 'Fixed TOOL operation refused')
                    self.assertEqual(len(observed), index + 1)

    def test_identity_reason_requires_the_exact_owned_downloader_exit_in_the_receipt(self):
        reasons = ('original','dump-policy','dump-policy-root-only','set-dumpable','drop-groups','drop-gid','drop-uid',
                   'post-dumpable','set-no-new-privs','post-ids','status','capabilities','observe-no-new-privs')
        report = tool_owner_report()
        report.update(complete=False, failure='fixed-archive-acquisition')
        for key in ('transfer','materialized'):
            del report[key]
        outcomes = report['processOutcomes']
        for operation in ('payload-bind','payload-remount','payload-unmount'):
            del outcomes[operation]
        downloader = outcomes['archive-downloader']
        downloader.update(reason='command-failed', exit=2)
        B._validate_tool_capture(B.canonical(report | {'failureReason':'download-identity'}), '1')
        start = 1000
        for code, reason in enumerate(reasons, 8):
            label = 'download-identity-' + reason
            course = C.Course('123', 1001, 1001, start)
            course.kernel = Mock()
            course.kernel.own_children.return_value = []
            argv = ['/usr/bin/python3','-I','-B',str(course.path / 'code' / C.SOURCE), '--download',
                    '1001','1001',repr(course.active)]
            with self.subTest(code=code, reason=reason), patch.object(C.time, 'monotonic', return_value=start), \
                 patch.object(C, 'quiet_command_stdio', nullcontext), \
                 patch.object(C, '_run_tool_command', return_value=owned_result(reason='command-failed', commandExit=code)), \
                 self.assertRaises(C.ToolRefusal) as failure:
                course.command(argv, course.active, C.ACTIVE_SECONDS, download_slots=(12, (3, 4, 5, 6, 7), {}))
            self.assertEqual(failure.exception.reason, label)
            downloader.update(course.state['processOutcomes']['archive-downloader'])
            accepted = report | {'failureReason':label}
            B._validate_tool_capture(B.canonical(accepted), '1')
            wrong_identity = 'download-identity-drop-gid' if reason == 'original' else 'download-identity-original'
            for wrong in ('download-identity', 'command-failed', wrong_identity):
                with self.assertRaisesRegex(ValueError, 'identity reason lacks its exact child exit'):
                    B._validate_tool_capture(B.canonical(accepted | {'failureReason':wrong}), '1')
            with patch.dict(downloader, exit=2), \
                 self.assertRaisesRegex(ValueError, 'identity reason lacks its exact child exit'):
                B._validate_tool_capture(B.canonical(accepted), '1')

        for change in (
            lambda value: value.update(failure='strict-materialization'),
            lambda value: value['processOutcomes'].pop('namespace-private'),
            lambda value: value['processOutcomes']['namespace-private'].update(reason='command-failed', exit=2),
            lambda value: value['processOutcomes'].update({'payload-bind':outcomes['namespace-private'].copy()}),
            lambda value: value['processOutcomes']['archive-downloader'].update(escapedSession=True),
        ):
            malformed = copy.deepcopy(accepted)
            change(malformed)
            with self.assertRaisesRegex(ValueError, 'identity reason lacks its exact child exit'):
                B._validate_tool_capture(B.canonical(malformed), '1')

        uncertain = copy.deepcopy(accepted)
        uncertain.update(cleanup='refused', ownedProcessesSettled=False, cleanupReason='group-uncertain')
        for key in ('mountsAbsent', 'namespaceAbsent'):
            del uncertain[key]
        uncertain_child = uncertain['processOutcomes']['archive-downloader']
        uncertain_child.update(quiescent=False, settlementReason='group-uncertain')
        B._validate_tool_capture(B.canonical(uncertain), '1')
        with patch.dict(uncertain_child, reaped=False), \
             self.assertRaisesRegex(ValueError, 'identity reason lacks its exact child exit'):
            B._validate_tool_capture(B.canonical(uncertain), '1')
        for interrupted in ('deadline', 'owner-interrupted'):
            with patch.dict(downloader, reason=interrupted):
                B._validate_tool_capture(B.canonical(accepted | {'failureReason':interrupted}), '1')

    def test_writer_transport_delivers_exact_kernel_credentials_cloexec_and_terminal_eof(self):
        with ExitStack() as held:
            sender, receiver = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET | socket.SOCK_CLOEXEC)
            held.enter_context(sender)
            held.enter_context(receiver)
            receiver.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
            inputs = [held.enter_context(tempfile.TemporaryFile()).fileno() for _ in C.DOWNLOAD_SLOTS]
            deadline = time.monotonic() + 3
            C._send_writer_message(sender, b'W', [(socket.SOL_SOCKET, socket.SCM_RIGHTS,
                                   b''.join(C.RIGHT.pack(fd) for fd in inputs))], deadline)
            sender.close()
            with C._writer_message(receiver, deadline) as (data, credentials, fds, records):
                self.assertEqual((data, credentials, records), (b'W', [(os.getpid(), os.getuid(), os.getgid())], 1))
                self.assertEqual(len(set(fds)), 5)
                self.assertTrue(set(fds).isdisjoint(inputs))
                self.assertEqual([C.birth(os.fstat(fd)) for fd in fds], [C.birth(os.fstat(fd)) for fd in inputs])
                self.assertTrue(all(not os.get_inheritable(fd) for fd in fds))
                with C._writer_message(receiver, deadline) as end:
                    self.assertEqual(end, (b'', [], (), 0))
            for fd in fds:
                with self.assertRaises(OSError):
                    os.fstat(fd)

    def test_every_delivered_right_closes_before_framing_refusal(self):
        rights = (socket.SOL_SOCKET, socket.SCM_RIGHTS)
        for data, ancillary, flags in (
            (b'', [(*rights, C.RIGHT.pack(31))], 0),
            (b'W', [(*rights, C.RIGHT.pack(31) + b'x'), (*rights, C.RIGHT.pack(32))], 0),
            (b'W', [(*rights, C.RIGHT.pack(31)), (*rights, C.RIGHT.pack(32))], socket.MSG_CTRUNC),
            (b'W', [(*rights, C.RIGHT.pack(31)), (socket.SOL_SOCKET, socket.SCM_CREDENTIALS, b'x')], socket.MSG_TRUNC),
        ):
            endpoint = Mock()
            endpoint.recvmsg.return_value = (data, ancillary, flags, None)
            with self.subTest(data=data, flags=flags, records=len(ancillary)), \
                 patch.object(C.select, 'select', return_value=([endpoint], [], [])), \
                 patch.object(C.os, 'close') as close, \
                 self.assertRaisesRegex(ValueError, 'writer channel framing differs'):
                with C._writer_message(endpoint, time.monotonic() + 3):
                    self.fail('malformed frame reached the writer grant')
            expected = [31, 32] if len(ancillary) == 2 and ancillary[1][:2] == rights else [31]
            self.assertCountEqual([item.args[0] for item in close.call_args_list], expected)

    def test_writer_grant_requires_held_native_identity_slots_and_no_late_send(self):
        birth = {'pid':77,'parent':25,'group':77,'session':77,'start':32,'state':'S'}
        status = b'Uid:\t1001 1001 1001 1001\nGid:\t1002 1002 1002 1002\nGroups:\t\nNoNewPrivs:\t1\n'
        status += b''.join(key + b':\t0000000000000000\n' for key in (b'CapInh', b'CapPrm', b'CapEff', b'CapAmb'))
        slots = (12, (31, 32, 33, 34, 35), {name:(1, fd) for name, fd in zip(C.DOWNLOAD_SLOTS, range(31, 36))})
        for case in ('valid', 'eof', 'foreign-peer', 'extra-right', 'wrong-fsuid', 'wrong-policy',
                     'changed-birth', 'exited', 'foreign-slot', 'surplus', 'late', 'interrupted'):
            channel, kernel = Mock(), Mock()
            channel.sendmsg.return_value = 1
            ready = (b'R2', [(77, 1001, 1002)], (), 0)
            if case == 'eof':
                ready = (b'', [], (), 0)
            if case == 'foreign-peer':
                ready = (b'R2', [(78, 1001, 1002)], (), 0)
            if case == 'extra-right':
                ready = (b'R2', [(77, 1001, 1002)], (55,), 1)
            kernel.identity.side_effect = [birth, birth | {'start':33 if case == 'changed-birth' else 32}]

            def metadata(fd):
                return SimpleNamespace(st_dev=1, st_ino=fd, st_uid=0, st_gid=0, st_mode=stat.S_IFREG|0o600,
                                       st_size=0, st_nlink=1, st_mtime_ns=0, st_ctime_ns=0)

            def named(_folder, name):
                return metadata(slots[2][name][1] + (1 if case == 'foreign-slot' else 0))

            with self.subTest(case=case), ExitStack() as mocked:
                mocked.enter_context(patch.object(C, '_writer_message', return_value=nullcontext(ready)))
                native_status = status.replace(b'1001\n', b'0\n') if case == 'wrong-fsuid' else status
                held_status = mocked.enter_context(patch.object(C, '_downloader_status', return_value=native_status))
                mocked.enter_context(patch.object(C, 'bounded_proc', return_value=b'1\n' if case == 'wrong-policy' else b'2\n'))
                mocked.enter_context(patch.object(C.select, 'select', side_effect=lambda read, *_:
                    (read if case == 'exited' or case == 'surplus' and read == [channel] else [], [], [])))
                mocked.enter_context(patch.object(C, 'download_writers'))
                mocked.enter_context(patch.object(C.os, 'fstat', side_effect=metadata))
                mocked.enter_context(patch.object(C.os, 'get_inheritable', return_value=False))
                mocked.enter_context(patch.object(C, 'named', side_effect=named))
                deadline = time.monotonic() + (-1 if case == 'late' else 3)
                args = (channel, deadline, lambda: case == 'interrupted', kernel, 11, birth, 1001, 1002, slots)
                if case == 'valid':
                    self.assertEqual(C._download_writer_handoff(*args), C.DUMP_POLICIES[b'2'])
                    held_status.assert_called_once_with(77, deadline)
                    channel.sendmsg.assert_called_once_with([b'W'], [(socket.SOL_SOCKET, socket.SCM_RIGHTS,
                        b''.join(C.RIGHT.pack(fd) for fd in slots[1]))], socket.MSG_DONTWAIT | socket.MSG_NOSIGNAL)
                elif case == 'eof':
                    self.assertIsNone(C._download_writer_handoff(*args))
                    kernel.identity.assert_not_called()
                else:
                    with self.assertRaises(ValueError):
                        C._download_writer_handoff(*args)
                if case != 'valid':
                    channel.sendmsg.assert_not_called()

    def test_held_downloader_status_reads_complete_eof_before_the_same_frontier(self):
        proc = SimpleNamespace(st_dev=1, st_ino=77, st_mode=stat.S_IFDIR|0o500)
        status = SimpleNamespace(st_dev=1, st_ino=78, st_mode=stat.S_IFREG|0o444)
        for case in ('short-reads', 'empty', 'too-large', 'late', 'replaced-status', 'replaced-process'):
            now = 100
            chunks = iter([b''] if case == 'empty' else
                          [b'x'*4096]*16 + [b'x'] if case == 'too-large' else [b'Uid:', b'\t1001\n', b''])
            reads = []
            names = []

            def read(fd, length):
                nonlocal now
                self.assertEqual(fd, 32)
                reads.append(length)
                if case == 'late':
                    now = 103
                return next(chunks)

            def named(fd, name):
                names.append((fd, name))
                row = proc if name == '77' else status
                if names.count((fd, name)) == 2 and case == ('replaced-process' if name == '77' else 'replaced-status'):
                    return SimpleNamespace(st_dev=row.st_dev, st_ino=90, st_mode=row.st_mode)
                return row

            with self.subTest(case=case), patch.object(C.time, 'monotonic', side_effect=lambda: now), \
                 patch.object(C.os, 'open', side_effect=[30, 31, 32]) as opened, \
                 patch.object(C.os, 'fstat', side_effect=lambda fd: proc if fd == 31 else status), \
                 patch.object(C, 'named', side_effect=named), patch.object(C.os, 'read', side_effect=read), \
                 patch.object(C.os, 'close') as closed:
                if case == 'short-reads':
                    self.assertEqual(C._downloader_status(77, 103), b'Uid:\t1001\n')
                    self.assertEqual(reads, [4096]*3)
                else:
                    with self.assertRaises(ValueError):
                        C._downloader_status(77, 103)
                self.assertEqual(opened.call_args_list, [call('/proc', C.DIR), call('77', C.DIR, dir_fd=30),
                                                        call('status', C.READ, dir_fd=31)])
                self.assertEqual(closed.call_args_list, [call(32), call(31), call(30)])
            if case == 'too-large':
                self.assertEqual(reads, [4096]*16 + [1])
            if case == 'late':
                self.assertEqual(reads, [4096])

    def test_downloader_waits_for_exact_grant_and_terminal_channel_before_tls(self):
        source = str(C.ROOT_PARENT / (C.ROOT_PREFIX + '123') / 'code' / C.SOURCE)
        writers = (31, 32, 33, 34, 35)
        for variant in ('valid', 'foreign-root', 'missing-right', 'inheritable', 'surplus', 'dumpable'):
            channel = Mock(family=socket.AF_UNIX)
            channel.getsockopt.side_effect = [socket.SOCK_SEQPACKET, 1]
            libc = Mock()
            libc.prctl.return_value = 2 if variant == 'dumpable' else 0
            packet = (b'W', [(21 if variant == 'foreign-root' else 20, 0, 0)],
                      writers[:-1] if variant == 'missing-right' else writers, 1)
            ending = (b'W', [(20, 0, 0)], writers, 1) if variant == 'surplus' else (b'', [], (), 0)
            deadline = time.monotonic() + 3
            with self.subTest(variant=variant), ExitStack() as mocks:
                mocks.enter_context(patch.object(C, '__file__', source))
                mocks.enter_context(patch.object(C.socket, 'socket', return_value=nullcontext(channel)))
                mocks.enter_context(patch.object(C.os, 'set_inheritable'))
                mocks.enter_context(patch.object(C.os, 'get_inheritable', return_value=variant == 'inheritable'))
                mocks.enter_context(patch.object(C.os, 'getppid', return_value=20))
                drop = mocks.enter_context(patch.object(C, '_drop_downloader', return_value=(b'2', libc)))
                message = mocks.enter_context(patch.object(C, '_writer_message', side_effect=map(nullcontext, (packet, ending))))
                send = mocks.enter_context(patch.object(C, '_send_writer_message'))
                check = mocks.enter_context(patch.object(C, 'download_writers', wraps=C.download_writers))
                if variant != 'missing-right':
                    check.side_effect = lambda _: None
                transfer = mocks.enter_context(patch.object(C, '_download_archives'))
                if variant == 'valid':
                    C.download(1001, 1002, deadline, deadline, 30)
                    self.assertEqual(message.call_count, 2)
                    transfer.assert_called_once_with(writers, deadline)
                else:
                    with self.assertRaises(C.ToolRefusal) as caught:
                        C.download(1001, 1002, deadline, deadline, 30)
                    self.assertEqual(caught.exception.reason, 'download-writer')
                    transfer.assert_not_called()
                drop.assert_called_once_with(1001, 1002)
                send.assert_called_once_with(channel, b'R2', [], deadline)

    def test_pregrant_eof_keeps_the_owned_exit_and_cannot_succeed(self):
        child = 4321
        argv = ['/usr/bin/python3','-I','-B','/fixed/owner.py','--download','1001','1002','144.0']
        slots = (12, (31, 32, 33, 34, 35), {})
        for code, observed_at, natural_exit, reason in ((10, 100, True, 'command-failed'), (0, 100, True, 'protocol-refused'),
                (-9, 103, False, 'deadline'), (10, 104, True, 'deadline')):
            now = 100
            kernel = Mock()
            kernel.own_children.return_value = []
            kernel.live_group.return_value = []
            root, peer = MagicMock(), MagicMock()
            admitted = {'pid':child}
            def observe(_pid):
                nonlocal now
                now = observed_at
                return natural_exit

            with self.subTest(code=code, observed_at=observed_at), patch.object(C.time, 'monotonic', side_effect=lambda: now), \
                 patch.object(C.time, 'sleep') as slept, \
                 patch.object(C.pathlib.Path, 'iterdir', return_value=iter([1])), \
                 patch.object(C.signal, 'getsignal', return_value=signal.SIG_DFL), patch.object(C.signal, 'signal'), \
                 patch.object(C.os, 'pipe', side_effect=[(10,11),(12,13)]), patch.object(C.os, 'close'), \
                 patch.object(C.socket, 'socketpair', return_value=(root, peer)), \
                 patch.object(C.os, 'fork', return_value=child), patch.object(C.os, 'pidfd_open', return_value=20), \
                 patch.object(C, '_admit_tool_command', return_value=admitted) as admit, \
                 patch.object(C, '_download_writer_handoff', return_value=None) as handoff, \
                 patch.object(C, '_wait_tool_exit', side_effect=observe) as wait, \
                 patch.object(C, '_stop_tool_command', return_value=(code, False)) as settle:
                result = C._run_tool_command(kernel, argv, 144, download_slots=slots)
            self.assertEqual(result, owned_result(reason=reason, commandExit=code))
            self.assertEqual(admit.call_args.args[4], 103)
            self.assertEqual(handoff.call_args.args[1], 103)
            root.close.assert_called_once_with()
            peer.close.assert_called_once_with()
            wait.assert_called_once_with(child)
            slept.assert_not_called()
            anchor = min(observed_at, 103)
            settle.assert_called_once_with(kernel, child, 20, admitted, anchor + 3, anchor + 6)
            self.assertEqual(kernel.live_group.call_count, int(observed_at < 103))

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
        self.assertFalse(C.course_complete(course, None, 'complete', start + 1))
        course.state['transfer']['writerHandoff'] = C.DUMP_POLICIES[b'2']
        self.assertTrue(C.course_complete(course, None, 'complete', start + 1))
        self.assertFalse(C.course_complete(course, 'strict-materialization', 'complete', start + 1))
        self.assertFalse(C.course_complete(course, None, 'refused', start + 1))
        self.assertFalse(C.course_complete(course, None, 'complete', start + 180))
        course.processes_settled = False
        self.assertFalse(C.course_complete(course, None, 'complete', start + 1))


if __name__ == '__main__':
    unittest.main()
