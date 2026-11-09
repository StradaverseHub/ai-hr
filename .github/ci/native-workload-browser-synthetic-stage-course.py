"""Root-owned, stage-only diagnostic. Invoke only from a sealed native receiver."""
import hashlib
import os
import re
import signal
import sys
import time
from contextlib import ExitStack
from types import ModuleType


_PREFIX = '.github/ci/native-workload-browser-'
_MODULES = ('synthetic-stage-owner', 'launch-view', 'synthetic-stage', 'synthetic-stage-cleanup', 'host')
_DRIVER = 'test/performance/native-workload-browser-driver.mjs'
_BROWSER = 'test/performance/native-workload-browser-server.mjs'
_PROBE = _PREFIX + 'host.py'
STAGE_MEMBERS = tuple(sorted((
    *(_PREFIX + name + '.py' for name in (*_MODULES, 'tool-course', 'tool-installation', 'toolchain',
                                         'synthetic-stage-course')),
    '.github/ci/owned-process.py', '.github/ci/runtime_inventory.py', 'deploy/admission/next_profile.py',
    'package.json', 'pnpm-lock.yaml', _DRIVER, _BROWSER,
)))
_SOURCE_MAX = 2 * 1024**2
_NODE_MAX = 256 * 1024**2
_VIEW_REFUSALS = frozenset((
    'launch-view-ancestry', 'launch-view-backing-identity', 'launch-view-capacity',
    'launch-view-copy-bound', 'launch-view-deadline', 'launch-view-directory', 'launch-view-empty-parent',
    'launch-view-fd-flags', 'launch-view-fd-mount', 'launch-view-foreign-mount', 'launch-view-fragment',
    'launch-view-manager-birth', 'launch-view-manager-executable', 'launch-view-manager-uid',
    'launch-view-mount-changed', 'launch-view-namespace', 'launch-view-pid-namespace', 'launch-view-proc-bound',
    'launch-view-proc-file', 'launch-view-proc-identity', 'launch-view-root', 'launch-view-root-identity',
    'launch-view-run', 'launch-view-run-mount', 'launch-view-stage-fd', 'launch-view-stage-mount',
))


def _capsule(tool, members, rows, deadline):
    tool.require(type(members) is dict and tuple(members) == STAGE_MEMBERS
                 and type(rows) is list and len(rows) == len(STAGE_MEMBERS), 'Fixed stage capsule required')
    hashes = {}
    for name, row in zip(STAGE_MEMBERS, rows, strict=True):
        tool.left(deadline)
        raw = members[name]
        tool.require(type(raw) is bytes and 0 < len(raw) <= _SOURCE_MAX
                     and type(row) is dict and type(row.get('size')) is int, 'Fixed stage source member required')
        blob = hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0', usedforsecurity=False)
        blob.update(raw)
        digest = hashlib.sha256(raw).hexdigest()
        tool.require(row == {'path': name, 'mode': '100644', 'size': len(raw), 'gitBlob': blob.hexdigest(),
                             'sha256': digest}, 'Fixed stage source row differs')
        hashes[name] = digest
    digest = hashlib.sha256(tool.canonical(rows)).hexdigest()
    tool.left(deadline)
    return digest, hashes


def _failure(tool, phase, error):
    reason = tool.refusal_reason(error)
    if type(error) is ValueError and len(error.args) == 1 and type(error.args[0]) is str and error.args[0] in _VIEW_REFUSALS:
        reason = error.args[0]
    elif reason == 'complete' or reason not in {
        *tool.PROCESS_REASONS, *tool.DOWNLOAD_FAILURES.values(), 'host-io',
        'contract-refused', 'strict-archive-pin', 'strict-archive-or-tree',
    }:
        reason = 'contract-refused'
    return {'phase': phase, 'reason': reason}


def _stage(tool, course, members, hashes, node_bytes, node_sha256, report):
    code = course.path / 'code'
    modules = []
    for name in _MODULES:
        tool.left(course.active)
        path = _PREFIX + name + '.py'
        modules.append(tool.source_module('aihr_synthetic_stage_' + name.replace('-', '_'), code / path, members[path]))
    owner, view, finalizer, cleanup, host = modules
    try:
        with owner.owned_synthetic_stage(tool, course, view, finalizer, cleanup, host) as stage:
            try:
                prepared = stage.prepare(node=finalizer.BoundStageFile(node_bytes, node_sha256),
                                         driver=finalizer.BoundStageFile(members[_DRIVER], hashes[_DRIVER]),
                                         browser=finalizer.BoundStageFile(members[_BROWSER], hashes[_BROWSER]),
                                         probe=finalizer.BoundStageFile(members[_PROBE], hashes[_PROBE]))
                rows = [(row.path, row.kind, row.mode, row.bytes, row.sha256) for row in prepared.snapshot.members]
                evidence = {'treeSha256': hashlib.sha256(tool.canonical(rows)).hexdigest(), 'entries': len(rows),
                            'fileBytes': sum(row[3] for row in rows),
                            'currentRootMatched': True, 'managerRootMatched': True}
                tool.left(course.active)
                report['stage'] = evidence
            except BaseException as error:
                report.setdefault('failure', _failure(tool, 'stage-preparation', error))
            finally:
                # This receiver never receives authority to start any role.
                # An attempted but unbound mkdir is still a cleanup refusal.
                if stage.pending is not None or stage.run_fd is not None:
                    report['cleanup']['stage'] = 'refused'
                    try:
                        stage.dispose()
                        tool.left(course.deadline)
                        report['cleanup']['stage'] = 'complete'
                    except BaseException as error:
                        report.setdefault('failure', _failure(tool, 'stage-disposal', error))
    except BaseException as error:
        if report['cleanup']['stage'] != 'not-acquired':
            report['cleanup']['stage'] = 'refused'
        report.setdefault('failure', _failure(tool, 'stage-owner-settlement', error))


def _archive_cleanup(tool, course, members, report):
    if course.creation_attempted:
        report['cleanup']['archives'] = 'refused'
    try:
        if course.created:
            course.dispose_mounts()
            course.dispose_tree(members)
            tool.require(course.state.get('mountsAbsent') is True and course.state.get('namespaceAbsent') is True
                         and course.processes_settled is True, 'Exact archive cleanup proof required')
            tool.left(course.deadline)
            report['cleanup']['archives'] = 'complete'
        elif course.creation_attempted:
            report.setdefault('failure', {'phase': 'archive-disposal', 'reason': 'namespace-creation-unproved'})
    except BaseException as error:
        report.setdefault('failure', _failure(tool, 'archive-disposal', error))
    finally:
        if course.root is not None:
            try:
                os.close(course.root)
            except OSError as error:
                report['cleanup']['archives'] = 'refused'
                report.setdefault('failure', _failure(tool, 'archive-disposal', error))


def run_stage(tool, run, source, uid, gid, members, rows, event_sha, *, node_bytes, node_sha256):
    """Use the caller's reviewed source rows and protected fixed Node input once."""
    start = time.monotonic()
    if type(tool) is not ModuleType:
        raise ValueError('Fixed TOOL owner required')
    tool.require(sys.platform == 'linux' and os.uname().machine == 'x86_64'
                 and os.getresuid() == os.getresgid() == (0, 0, 0)
                 and type(run) is str and re.fullmatch(r'[1-9][0-9]{0,15}', run)
                 and int(run) <= 9007199254740991
                 and all(type(value) is str and re.fullmatch(r'[0-9a-f]{%d}' % length, value)
                         for value, length in ((source, 40), (event_sha, 64), (node_sha256, 64)))
                 and all(type(value) is int and 0 < value < 2**32 - 1 for value in (uid, gid))
                 and type(node_bytes) is bytes and len(node_bytes) <= _NODE_MAX and node_bytes.startswith(b'\x7fELF'),
                 'Actual root synthetic stage input required')
    course = tool.Course(run, uid, gid, start)
    capsule, hashes = _capsule(tool, members, rows, course.active)
    report = {'kind': 'NATIVE_BROWSER_SYNTHETIC_STAGE_COMPONENT', 'source': source, 'controller': source,
              'runId': run, 'attempt': 1, 'job': 'native-test', 'eventSha256': event_sha,
              'sourceCapsuleSha256': capsule, 'cleanup': {'stage': 'not-acquired', 'archives': 'not-acquired'},
              'rolesStarted': False, 'browserStarted': False, 'applicationBuilt': False, 'databaseStarted': False,
              'nativeWorkloadQualified': False, 'releaseAuthorized': False}
    phase = 'root-parent-acquisition'
    try:
        with ExitStack() as held:
            def interrupt(_number, _frame):
                raise InterruptedError('Synthetic stage owner interrupted')

            for signum in (signal.SIGINT, signal.SIGTERM):
                held.callback(signal.signal, signum, signal.signal(signum, interrupt))
            held.callback(os.umask, os.umask(0o077))
            release = tool.bounded_proc('/usr/lib/os-release', 65536).splitlines()
            tool.require(b'ID=ubuntu' in release and b'VERSION_ID="24.04"' in release, 'Actual Ubuntu 24.04 stage required')
            tool.left(course.active)
            mountinfo = 'deploy/admission/next_profile.py'
            course.mounts = tool.source_module('aihr_synthetic_stage_mountinfo', mountinfo, members[mountinfo])
            parent = tool._open_tool_parent(held)
            try:
                phase = 'root-acquisition'
                course.create(parent)
                phase = 'source-capsule'
                course.install_capsule(members)
                phase = 'private-mount-namespace'
                course.enter_private_mount_namespace()
                phase = 'fixed-archive-acquisition'
                course.acquire()
                phase = 'stage-preparation'
                _stage(tool, course, members, hashes, node_bytes, node_sha256, report)
            except BaseException as error:
                report.setdefault('failure', _failure(tool, phase, error))
            finally:
                _archive_cleanup(tool, course, members, report)
            phase = 'owner-settlement'
    except BaseException as error:
        report.setdefault('failure', _failure(tool, phase, error))
    ended = time.monotonic()
    if ended >= course.deadline:
        for name, state in report['cleanup'].items():
            if state != 'not-acquired':
                report['cleanup'][name] = 'refused'
        report.setdefault('failure', {'phase': 'owner-settlement', 'reason': 'deadline'})
    report['elapsedMs'] = min(tool.TOTAL_SECONDS * 1000, int((ended - start) * 1000))
    report['ownedProcessesSettled'] = course.processes_settled is True
    complete = ('failure' not in report and 'stage' in report and report['ownedProcessesSettled']
                and report['cleanup'] == {'stage': 'complete', 'archives': 'complete'})
    report['complete'] = complete
    if not complete:
        report.setdefault('failure', {'phase': 'owner-settlement', 'reason': 'contract-refused'})
    return report
