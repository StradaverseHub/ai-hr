"""Model the stage-only course's admission and settlement, without host operations."""
import hashlib
import os
import unittest
from contextlib import ExitStack, contextmanager
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import patch


def load(name, sibling):
    path = Path(__file__).with_name(sibling)
    module = ModuleType(name)
    module.__file__ = str(path)
    exec(compile(path.read_bytes(), str(path), 'exec', dont_inherit=True), module.__dict__)
    return module


S = load('stage_course_model', 'native-workload-browser-synthetic-stage-course.py')
T = load('stage_course_tool_model', 'native-workload-browser-tool-course.py')


class StageCourseModels(unittest.TestCase):
    def setUp(self):
        self.members = {path: b'fixture ' + path.encode() for path in S.STAGE_MEMBERS}
        self.rows = [
            {'path': path, 'mode': '100644', 'size': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(),
             'gitBlob': hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw, usedforsecurity=False).hexdigest()}
            for path, raw in self.members.items()
        ]
        self.node = b'\x7fELFfictional'
        self.node_sha = hashlib.sha256(self.node).hexdigest()
        self.now = 100
        self.course = T.Course('427', 1001, 1001, self.now)
        self.events = []
        self.stage_mode = 'complete'
        self.archive_mode = 'complete'
        self.stage = SimpleNamespace(prepare=self.prepare, dispose=self.dispose_stage, pending=None, run_fd=None)

    @contextmanager
    def owner(self, tool, course, view, finalizer, cleanup, host):
        self.assertIs(tool, T)
        self.assertIs(course, self.course)
        self.assertEqual((view.__name__, finalizer.__name__, cleanup.__name__, host.__name__), (
            'aihr_synthetic_stage_launch_view', 'aihr_synthetic_stage_synthetic_stage',
            'aihr_synthetic_stage_synthetic_stage_cleanup', 'aihr_synthetic_stage_host',
        ))
        self.events.append('stage-enter')
        try:
            yield self.stage
        finally:
            self.events.append('stage-exit')
            if self.stage_mode == 'owner-close-error':
                raise OSError('fixture path must not be exported')

    def source_module(self, name, path, raw):
        relative = str(path)
        if path != 'deploy/admission/next_profile.py':
            relative = str(path.relative_to(self.course.path / 'code'))
        self.assertEqual(raw, self.members[relative])
        module = ModuleType(name)
        module.owned_synthetic_stage = self.owner
        module.BoundStageFile = lambda data, digest: (data, digest)
        return module

    def create(self, fd):
        self.assertEqual(fd, 91)
        self.events.append('create')
        self.course.creation_attempted = self.course.created = True
        self.course.root = 92

    def prepare(self, **files):
        self.events.append('stage-prepare')
        expected = {'driver': S._DRIVER, 'browser': S._BROWSER, 'probe': S._PROBE}
        self.assertEqual(files, {'node': (self.node, self.node_sha), **{
            role: (self.members[path], hashlib.sha256(self.members[path]).hexdigest()) for role, path in expected.items()
        }})
        if self.stage_mode == 'uncertain-prepare':
            self.stage.pending = 'launch-source'
            raise InterruptedError('fixture raw unknown stage birth')
        self.stage.run_fd = 93
        if self.stage_mode == 'late-active':
            self.now = self.course.active
        row = SimpleNamespace(path='node', kind='file', mode=0o555, bytes=len(self.node), sha256=self.node_sha)
        return SimpleNamespace(snapshot=SimpleNamespace(members=(row,)))

    def dispose_stage(self):
        self.events.append('stage-dispose')
        if self.stage_mode == 'uncertain-prepare':
            raise ValueError('fixture raw unknown entry')

    def dispose_mounts(self):
        self.events.append('mount-dispose')
        if self.archive_mode == 'uncertain':
            self.course.processes_settled = False
            raise T.ToolRefusal('fixture raw mount path', 'group-uncertain')
        self.course.state['mountsAbsent'] = True

    def dispose_tree(self, members):
        self.events.append('tree-dispose')
        self.assertIs(members, self.members)
        if self.archive_mode != 'unproved':
            self.course.state['namespaceAbsent'] = True
        if self.archive_mode == 'late-total':
            self.now = self.course.deadline

    def run_course(self):
        with ExitStack() as held:
            held.enter_context(patch.object(S.sys, 'platform', 'linux'))
            held.enter_context(patch.object(os, 'uname', return_value=SimpleNamespace(machine='x86_64')))
            for name in ('getresuid', 'getresgid'):
                held.enter_context(patch.object(os, name, return_value=(0, 0, 0)))
            held.enter_context(patch.object(S.signal, 'signal', return_value=None))
            held.enter_context(patch.object(os, 'umask', return_value=0o022))
            held.enter_context(patch.object(os, 'close', side_effect=lambda fd: self.events.append(('close', fd))))
            held.enter_context(patch.object(S.time, 'monotonic', side_effect=lambda: self.now))
            held.enter_context(patch.object(self.course, 'create', self.create))
            held.enter_context(patch.multiple(
                self.course, install_capsule=lambda _: self.events.append('seal'),
                enter_private_mount_namespace=lambda: self.events.append('private'),
                acquire=lambda: self.events.append('acquire'), dispose_mounts=self.dispose_mounts,
                dispose_tree=self.dispose_tree,
            ))
            held.enter_context(patch.multiple(
                T, Course=lambda *_: self.course, source_module=self.source_module,
                bounded_proc=lambda *_: b'ID=ubuntu\nVERSION_ID="24.04"\n', _open_tool_parent=lambda _: 91,
            ))
            return S.run_stage(T, '427', 'a' * 40, 1001, 1001, self.members, self.rows, 'b' * 64,
                               node_bytes=self.node, node_sha256=self.node_sha)

    def test_fixed_capsule_roles_and_both_positive_cleanup_owners(self):
        report = self.run_course()
        self.assertEqual(self.events, ['create', 'seal', 'private', 'acquire', 'stage-enter', 'stage-prepare',
                                       'stage-dispose', 'stage-exit', 'mount-dispose', 'tree-dispose', ('close', 92)])
        self.assertIs(report['complete'], True)
        self.assertEqual(report['cleanup'], {'stage': 'complete', 'archives': 'complete'})
        self.assertEqual(report['stage'], {
            'treeSha256': hashlib.sha256(T.canonical([('node', 'file', 0o555, len(self.node), self.node_sha)])).hexdigest(),
            'entries': 1, 'fileBytes': len(self.node), 'currentRootMatched': True, 'managerRootMatched': True,
        })
        self.assertEqual(report['sourceCapsuleSha256'], hashlib.sha256(T.canonical(self.rows)).hexdigest())
        self.assertNotIn('failure', report)
        for claim in ('rolesStarted', 'browserStarted', 'applicationBuilt', 'databaseStarted',
                      'nativeWorkloadQualified', 'releaseAuthorized'):
            self.assertIs(report[claim], False)

    def test_different_member_identity_refuses_before_owned_side_effect(self):
        self.rows[0]['gitBlob'] = '0' * 40
        with self.assertRaisesRegex(ValueError, '^Fixed stage source row differs$'):
            self.run_course()
        self.assertEqual(self.events, [])

    def test_unknown_stage_birth_preserves_first_bounded_failure_and_settles_archives_independently(self):
        self.stage_mode = 'uncertain-prepare'
        report = self.run_course()
        self.assertIs(report['complete'], False)
        self.assertNotIn('stage', report)
        self.assertEqual(report['failure'], {'phase': 'stage-preparation', 'reason': 'owner-interrupted'})
        self.assertEqual(report['cleanup'], {'stage': 'refused', 'archives': 'complete'})
        self.assertEqual(self.events[-5:], ['stage-dispose', 'stage-exit', 'mount-dispose', 'tree-dispose', ('close', 92)])
        self.assertNotIn('fixture raw', str(report))

    def test_stage_view_result_at_exact_active_boundary_is_never_published(self):
        self.stage_mode = 'late-active'
        report = self.run_course()
        self.assertIs(report['complete'], False)
        self.assertNotIn('stage', report)
        self.assertEqual(report['failure'], {'phase': 'stage-preparation', 'reason': 'deadline'})
        self.assertEqual(report['cleanup'], {'stage': 'complete', 'archives': 'complete'})
        self.assertEqual(report['elapsedMs'], 150000)

    def test_stage_close_failure_and_unknown_processes_cannot_promote_cleanup(self):
        self.stage_mode, self.archive_mode = 'owner-close-error', 'uncertain'
        report = self.run_course()
        self.assertIs(report['complete'], False)
        self.assertIs(report['ownedProcessesSettled'], False)
        self.assertEqual(report['failure'], {'phase': 'stage-owner-settlement', 'reason': 'host-io'})
        self.assertEqual(report['cleanup'], {'stage': 'refused', 'archives': 'refused'})
        self.assertIn('stage', report)
        self.assertNotIn('tree-dispose', self.events)
        self.assertEqual(self.events[-1], ('close', 92))
        self.assertNotIn('fixture path', str(report))

    def test_late_total_settlement_keeps_stage_observation_but_cannot_complete(self):
        self.archive_mode = 'late-total'
        report = self.run_course()
        self.assertIs(report['complete'], False)
        self.assertIn('stage', report)
        self.assertEqual(report['failure'], {'phase': 'archive-disposal', 'reason': 'deadline'})
        self.assertEqual(report['cleanup'], {'stage': 'refused', 'archives': 'refused'})
        self.assertEqual(report['elapsedMs'], 180000)

    def test_archive_cleanup_without_exact_absence_readback_cannot_complete(self):
        self.archive_mode = 'unproved'
        report = self.run_course()
        self.assertIs(report['complete'], False)
        self.assertEqual(report['cleanup'], {'stage': 'complete', 'archives': 'refused'})
        self.assertEqual(report['failure'], {'phase': 'archive-disposal', 'reason': 'contract-refused'})


if __name__ == '__main__':
    unittest.main()
