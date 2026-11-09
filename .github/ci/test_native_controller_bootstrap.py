"""Disposable filesystem/source controls only; no sudo, mount, Git, Node or app."""
import hashlib
import importlib.util
import os
import pathlib
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('bootstrap_source_controls', pathlib.Path(__file__).with_name('native-controller-bootstrap.py'))
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)


def environment():
    return {'GITHUB_ACTIONS': 'true', 'CI': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted', 'RUNNER_OS': 'Linux',
        'GITHUB_REPOSITORY': 'StradaverseHub/ai-hr', 'GITHUB_REPOSITORY_ID': '1333414856', 'GITHUB_RUN_ATTEMPT': '1',
        'GITHUB_WORKFLOW': 'alpha-staging-ci', 'GITHUB_JOB': 'native-test', 'GITHUB_RUN_ID': '123',
        'AIHR_CI_HEAD': 'a'*40, 'AIHR_CI_CONTROL_HEAD': 'b'*40, 'GITHUB_SHA': 'b'*40,
        'GITHUB_WORKFLOW_REF': 'StradaverseHub/ai-hr/.github/workflows/alpha-staging.yml@refs/heads/codex/owned',
        'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_WORKSPACE': '/home/runner/work/ai-hr/ai-hr',
        'RUNNER_TEMP': '/home/runner/work/_temp', 'RUNNER_TOOL_CACHE': '/opt/hostedtoolcache'}


class BootstrapControls(unittest.TestCase):
    def test_receiver_is_cached_before_even_controller_metadata_git(self):
        class StopBeforeExternalProgram(Exception):
            pass
        with tempfile.TemporaryDirectory() as folder:
            workspace = pathlib.Path(folder).resolve()
            controller = workspace/'automation'
            script = controller/M.SCRIPT
            script.parent.mkdir(parents=True)
            original = b'# original committed stdlib receiver model\n'
            script.write_bytes(original)
            script.chmod(0o644)
            cached = []
            read = M.read
            def observe_read(root, relative, *args):
                result = read(root, relative, *args)
                if relative == M.SCRIPT:
                    cached.append(result[0])
                return result
            def metadata_git(*_args, **_kwargs):
                # Model mutation at this boundary, never execute a hook/root program.
                script.write_bytes(b'# changed by a metadata callback\n')
                self.assertEqual(cached, [original])
                raise StopBeforeExternalProgram()
            with mock.patch.object(M, '__file__', str(script)), mock.patch.dict(M.os.environ, environment(), clear=True), \
                 mock.patch.object(M, 'context', return_value=('123', workspace)), mock.patch.object(M, 'read', side_effect=observe_read), \
                 mock.patch.object(M, 'git', side_effect=metadata_git), self.assertRaises(StopBeforeExternalProgram):
                M.prepare()

    def test_unprotected_prepare_never_observes_candidate_source_git(self):
        class StopBeforeExternalProgram(Exception):
            pass
        with tempfile.TemporaryDirectory() as folder:
            workspace = pathlib.Path(folder).resolve()
            controller = workspace/'automation'
            script = controller/M.SCRIPT
            script.parent.mkdir(parents=True)
            original = b'# bounded receiver model, never executed\n'
            script.write_bytes(original)
            script.chmod(0o644)
            node = workspace/'node'
            node.write_bytes(b'\x7fELF synthetic fixture, never executed\n')
            node.chmod(0o755)
            observed = []
            def metadata_git(path, args, **_kwargs):
                observed.append(path)
                if args[0] == 'rev-parse':
                    return ('b'*40+'\n').encode()
                if args[0] == 'show':
                    return original
                if args[0] == 'ls-files':
                    return ('100644 '+'c'*40+' 0\towner.mjs\0').encode()
                return b''
            with mock.patch.object(M, '__file__', str(script)), mock.patch.dict(M.os.environ, environment(), clear=True), \
                 mock.patch.object(M, 'context', return_value=('123', workspace)), mock.patch.object(M, 'git', side_effect=metadata_git), \
                 mock.patch.object(M, 'snapshot', return_value=([], 0)), mock.patch.object(M.shutil, 'which', return_value=str(node)), \
                 mock.patch.object(M.subprocess, 'run', side_effect=StopBeforeExternalProgram), self.assertRaises(StopBeforeExternalProgram):
                M.prepare()
            self.assertTrue(observed)
            self.assertEqual(set(observed), {controller})

    def test_scope_refuses_non_native_later_attempt_foreign_context_and_credential_fields(self):
        self.assertEqual(M.context(environment()), ('123', pathlib.Path('/home/runner/work/ai-hr/ai-hr')))
        for key, value in [('GITHUB_JOB', 'test'), ('GITHUB_RUN_ATTEMPT', '2'), ('GITHUB_REPOSITORY_ID', '2'),
                           ('GITHUB_SHA', 'c'*40), ('GITHUB_RUN_ID', '../123'), ('GH_TOKEN', 'fictional-secret')]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                M.context(environment() | {key: value})

    def test_member_grammar_rejects_traversal_links_control_and_depth(self):
        self.assertEqual(M.name('.github/ci/owner.mjs'), '.github/ci/owner.mjs')
        for value in ('../owner', '/owner', 'a//b', 'a/./b', 'a\\b', 'a\0b', 'a\nb', '/'.join(['a']*129)):
            with self.subTest(value=value), self.assertRaises(ValueError):
                M.name(value)

    def test_descriptor_read_has_real_byte_and_metadata_refusals(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder).resolve()
            file = root/'owner'
            file.write_bytes(b'fixed fictional owner bytes\n')
            file.chmod(0o644)
            with M.directory(root) as fd:
                raw, before = M.read(fd, 'owner', 1024)
                expected = {'size': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
                self.assertEqual(M.read(fd, 'owner', 1024, expected)[0], raw)
                for change in ({'size': len(raw)+1}, {'sha256': 'f'*64}):
                    with self.assertRaises(ValueError):
                        M.read(fd, 'owner', 1024, expected | change)
                with self.assertRaises(ValueError):
                    M.read(fd, 'owner', 1)
                (root/'link').symlink_to(file)
                with self.assertRaises(ValueError):
                    M.read(fd, 'link', 1024)
                os.link(file, root/'hard')
                with self.assertRaises(ValueError):
                    M.read(fd, 'owner', 1024)
                (root/'hard').unlink()
                file.chmod(0o666)
                with self.assertRaises(ValueError):
                    M.read(fd, 'owner', 1024)
                file.chmod(0o644)
                os.mkfifo(root/'fifo')
                with self.assertRaises(ValueError):
                    M.read(fd, 'fifo', 1024)

    def test_snapshot_copies_only_tracked_paths_and_complete_git_data_not_ignored_files(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder).resolve()
            (root/'.git').mkdir()
            (root/'.git/HEAD').write_bytes(b'synthetic Git metadata, not qualified\n')
            (root/'owner.mjs').write_bytes(b'// synthetic tracked bytes\n')
            (root/'ignored').write_bytes(b'not selected')
            for file in (root/'.git/HEAD', root/'owner.mjs', root/'ignored'):
                file.chmod(0o644)
            rows, total = M.snapshot(root, ['owner.mjs'])
            self.assertEqual([row['path'] for row in rows], ['.git', '.git/HEAD', 'owner.mjs'])
            self.assertEqual(total, len((root/'.git/HEAD').read_bytes()) + len((root/'owner.mjs').read_bytes()))
            (root/'.git/index.lock').write_bytes(b'incomplete Git mutation')
            with self.assertRaises(ValueError):
                M.snapshot(root, ['owner.mjs'])
            (root/'.git/index.lock').unlink()
            with mock.patch.object(M, 'MAX_ROWS', 1), self.assertRaises(ValueError):
                M.snapshot(root, ['owner.mjs'])
            with mock.patch.object(M, 'MAX_TOTAL', 1), self.assertRaises(ValueError):
                M.snapshot(root, ['owner.mjs'])


class ViewProbeControls(unittest.TestCase):
    def dispatch(self):
        ref = 'refs/heads/' + M.VIEW_BRANCH
        env = environment() | {'GITHUB_JOB': 'resolve', 'RUNNER_ARCH': 'X64', 'GITHUB_REF_TYPE': 'branch',
            'GITHUB_REF_NAME': M.VIEW_BRANCH, 'GITHUB_REF': ref, 'AIHR_CI_HEAD': 'b'*40,
            'GITHUB_WORKFLOW_SHA': 'b'*40,
            'GITHUB_WORKFLOW_REF': 'StradaverseHub/ai-hr/.github/workflows/alpha-staging.yml@' + ref}
        event = {'repository': {'id': 1333414856, 'full_name': 'StradaverseHub/ai-hr'}, 'ref': ref,
            'inputs': {'candidate_ref': M.VIEW_BRANCH, 'expected_sha': 'b'*40, 'test_parallelism': '4',
                       'build_only': 'false', 'diagnostics_only': 'true', 'controller_only': 'true',
                       'native_tool_only': 'false'}}
        return env, event

    def test_actual_resolve_admission_requires_the_fixed_real_context(self):
        env, event = self.dispatch()
        self.assertEqual(M.view_intent(env, event), ('123', pathlib.Path('/home/runner/work/ai-hr/ai-hr')))
        for key, value in [('GITHUB_JOB', 'native-test'), ('GITHUB_RUN_ATTEMPT', '2'), ('GITHUB_REF_TYPE', 'tag'),
                           ('GITHUB_WORKSPACE', '/tmp/workspace'), ('AIHR_CI_HEAD', 'a'*40),
                           ('GITHUB_WORKFLOW_SHA', 'a'*40), ('GH_TOKEN', 'fictional-secret')]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                M.view_intent(env | {key: value}, event)

    def test_other_provider_repository_or_ref_never_admits(self):
        env, event = self.dispatch()
        for changed in ({'ref': 'main'}, {'repository': event['repository'] | {'id': 2}},
                        {'repository': event['repository'] | {'full_name': 'other/repo'}}):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                M.view_intent(env, event | changed)

    def test_mode_cannot_be_mixed_or_forward_a_scope(self):
        env, event = self.dispatch()
        for key, value in [('controller_only', 'false'), ('diagnostics_only', 'false'), ('build_only', 'true'),
                           ('native_tool_only', 'true'), ('test_parallelism', '8'), ('commission_singleton_units', '["x"]'),
                           ('unexpected', 'value'), ('expected_sha', 'c'*40)]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                M.view_intent(env, event | {'inputs': event['inputs'] | {key: value}})
        self.assertEqual(M.view_intent(env, event | {'inputs': event['inputs'] | {'commission_singleton_units': ''}})[0], '123')

    def test_combined_namespace_call_refuses_errno_or_unchanged_net(self):
        original = {'mnt': (1, 1), 'net': (1, 2), 'user': (1, 3)}
        private = {'mnt': (1, 4), 'net': (1, 5), 'user': (1, 3)}
        libc = mock.Mock()
        libc.unshare.return_value = -1
        with mock.patch.object(M, 'view_namespaces') as read, self.assertRaisesRegex(ValueError, 'combined unshare'):
            M.view_enter_namespaces(libc, original)
        read.assert_not_called()
        libc.unshare.assert_called_once_with(M.VIEW_NEWNS | M.VIEW_NEWNET)
        libc.unshare.return_value = 0
        for observed in (private | {'net': original['net']}, private | {'mnt': original['mnt']},
                         private | {'user': (1, 6)}):
            with mock.patch.object(M, 'view_namespaces', return_value=observed), self.assertRaises(ValueError):
                M.view_enter_namespaces(libc, original)
        with mock.patch.object(M, 'view_namespaces', return_value=private):
            self.assertEqual(M.view_enter_namespaces(libc, original), private)

    def test_route_census_requires_down_loopback_and_reject_only_ipv6(self):
        interfaces, header = [(1, 'lo')], b'Iface Destination Gateway Flags\n'
        reject = b'0 00 0 00 0 0 0 0 00200200 lo\n'
        self.assertEqual(M.view_routes(interfaces, 8, header, reject), 1)
        for args in ((interfaces + [(2, 'eth0')], 8, header, reject),
                     (interfaces, 9, header, reject),
                     (interfaces, 8, header + b'eth0 row\n', reject),
                     (interfaces, 8, header, reject.replace(b'00200200', b'00200000')),
                     (interfaces, 8, header, reject.replace(b'lo', b'eth0'))):
            with self.subTest(args=args), self.assertRaises(ValueError):
                M.view_routes(*args)

    def test_exact_mount_census_separates_source_noexec_from_dependency_exec(self):
        root = M.view_scope('123')
        paths = [str(root / 'jail/project' / name) for name in ('app', 'node_modules')]
        first = {'id': 10, 'target': paths[0], 'options': {'ro', 'nosuid', 'nodev', 'noexec'}}
        second = {'id': 11, 'target': paths[1], 'options': {'ro', 'nosuid', 'nodev'}}
        self.assertEqual(M.view_mount_check([first, second], root), [first, second])
        for rows in ([first], [first, second | {'id': 10}], [first, second | {'target': paths[0]}],
                     [first, second | {'options': second['options'] | {'noexec'}}],
                     [first | {'options': first['options'] | {'rw'}}, second],
                     [first, second, second | {'target': paths[1] + '/foreign'}]):
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                M.view_mount_check(rows, root)

    def test_erofs_adjudication_refuses_dac_and_an_actual_writable_file(self):
        import errno
        with mock.patch.object(M.os, 'open', side_effect=OSError(errno.EROFS, 'readonly')):
            M.view_erofs('/closed')
        with mock.patch.object(M.os, 'open', side_effect=OSError(errno.EACCES, 'dac')), self.assertRaises(ValueError):
            M.view_erofs('/closed')
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder) / 'owned'
            path.write_bytes(b'unchanged')
            with self.assertRaisesRegex(ValueError, 'writable'):
                M.view_erofs(path)
            self.assertEqual(path.read_bytes(), b'unchanged')

    def test_original_namespace_or_foreign_entry_refuses_cleanup_without_removing_it(self):
        import time
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            (root / 'foreign').write_bytes(b'keep')
            with M.directory(root) as held, mock.patch.object(M, 'view_mount_rows', return_value=[]):
                with mock.patch.object(M, 'view_namespaces', return_value={'net': (1, 2)}), self.assertRaisesRegex(ValueError, 'namespace'):
                    M.view_cleanup(root, held, {}, os.getuid(), os.getgid(), None, {'net': (1, 1)}, time.monotonic() + 2)
                with mock.patch.object(M, 'view_namespaces', return_value={}), self.assertRaisesRegex(ValueError, 'cleanup'):
                    M.view_cleanup(root, held, {}, os.getuid(), os.getgid(), None, {}, time.monotonic() + 2)
            self.assertEqual((root / 'foreign').read_bytes(), b'keep')

    def test_positive_cleanup_requires_exact_writable_outputs_before_any_removal(self):
        import time
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            for name in M.VIEW_DIRS:
                (root / name).mkdir(mode=0o700)
            for name, raw in M.VIEW_SEEDS.items():
                path = root / name
                path.write_bytes(raw)
                path.chmod(0o600)
            births = {name: M.view_birth((root / name).lstat()) for name in (*M.VIEW_DIRS, *M.VIEW_SEEDS)}
            with M.directory(root) as held, mock.patch.object(M, 'view_mount_rows', return_value=[]), \
                 mock.patch.object(M, 'view_namespaces', return_value={}):
                def cleanup():
                    M.view_cleanup(root, held, births, os.getuid(), os.getgid(), None, {}, time.monotonic() + 2,
                                   require_outputs=True)
                with self.assertRaisesRegex(ValueError, 'outputs missing'):
                    cleanup()
                self.assertEqual((root / 'source/seed').read_bytes(), M.VIEW_SEEDS['source/seed'])
                (root / M.VIEW_CREATED[0]).mkdir(mode=0o700)
                for name in M.VIEW_CREATED[1:3]:
                    M.write(held, name, M.VIEW_WRITTEN, 0o600)
                M.write(held, M.VIEW_CREATED[3], M.canonical({'phases': list(M.VIEW_PHASES), 'ipv6RejectRows': 0}), 0o600)
                cleanup()
            self.assertEqual(list(root.iterdir()), [])

    def test_owned_entry_expiring_during_lookup_is_preserved(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            (root / 'source').mkdir()
            births = {'source': M.view_birth((root / 'source').lstat())}
            with M.directory(root) as held, mock.patch.object(M, 'view_mount_rows', return_value=[]), \
                 mock.patch.object(M, 'view_namespaces', return_value={}), \
                 mock.patch('time.monotonic', side_effect=(0, 0, 0, 2)), mock.patch.object(M.os, 'rmdir') as remove:
                with self.assertRaisesRegex(ValueError, 'frontier closed'):
                    M.view_cleanup(root, held, births, os.getuid(), os.getgid(), None, {}, 1)
                remove.assert_not_called()
            self.assertTrue((root / 'source').is_dir())

    def test_final_root_needs_same_birth_and_time_after_lookup(self):
        import stat
        from types import SimpleNamespace
        root = M.view_scope('123')
        observed = SimpleNamespace(st_dev=1, st_ino=2, st_mode=stat.S_IFDIR | 0o700, st_uid=0, st_gid=0)
        with mock.patch.object(M, 'view_mount_rows', return_value=[]), mock.patch.object(M, 'view_namespaces', return_value={}), \
             mock.patch.object(M, 'view_prefix'), mock.patch.object(M.os, 'stat', return_value=observed), \
             mock.patch.object(M.os, 'rmdir') as remove:
            with mock.patch('time.monotonic', return_value=0), self.assertRaisesRegex(ValueError, 'root identity'):
                M.view_remove_root(root, 7, (9, 9), (1, 3), None, {}, 1)
            with mock.patch('time.monotonic', side_effect=(0, 2)), self.assertRaisesRegex(ValueError, 'frontier closed'):
                M.view_remove_root(root, 7, (9, 9), (1, 2), None, {}, 1)
            remove.assert_not_called()

    def test_final_root_absence_is_anchored_and_requires_enoent(self):
        import stat
        from types import SimpleNamespace
        root = M.view_scope('123')
        observed = SimpleNamespace(st_dev=1, st_ino=2, st_mode=stat.S_IFDIR | 0o700, st_uid=0, st_gid=0)
        with mock.patch.object(M, 'view_mount_rows', return_value=[]), mock.patch.object(M, 'view_namespaces', return_value={}), \
             mock.patch.object(M, 'view_prefix') as parent, mock.patch('time.monotonic', return_value=0), \
             mock.patch.object(M.os, 'rmdir') as remove:
            for outcome in (observed, PermissionError('unreadable'), FileNotFoundError('absent')):
                with self.subTest(outcome=outcome), mock.patch.object(M.os, 'stat', side_effect=(observed, outcome)) as lookup:
                    if isinstance(outcome, FileNotFoundError):
                        M.view_remove_root(root, 7, (9, 9), (1, 2), None, {}, 1)
                    else:
                        with self.assertRaises((ValueError, PermissionError)):
                            M.view_remove_root(root, 7, (9, 9), (1, 2), None, {}, 1)
                    self.assertEqual(lookup.call_args_list, [mock.call(root.name, dir_fd=7, follow_symlinks=False)] * 2)
            self.assertEqual(remove.call_args_list, [mock.call(root.name, dir_fd=7)] * 3)
            self.assertEqual(parent.call_args_list, [mock.call(root, 7, (9, 9))] * 4)

    def test_cleanup_credit_waits_for_both_scope_exits(self):
        from contextlib import contextmanager
        from types import SimpleNamespace
        members = {key: b'' for key in M.VIEW_MEMBERS}
        real_directory = M.directory
        for failed_scope in ('precreate', 'owned', 'parent', None):
            with self.subTest(failed_scope=failed_scope), tempfile.TemporaryDirectory() as folder:
                root = pathlib.Path(folder).resolve() / 'exclusive'
                call = 1 if failed_scope == 'precreate' else 2
                members[M.VIEW_TOOL] = (f'calls = 0\ndef left(_stop):\n global calls\n calls += 1\n'
                                        f' if calls == {call}: raise ValueError("setup refused")\n').encode()
                @contextmanager
                def scopes(path, *, root_owned=False):
                    with real_directory(path) as held:
                        yield held
                    if (failed_scope == 'owned' and path == root) or (failed_scope == 'parent' and path == root.parent):
                        raise ValueError('scope exit refused')
                with mock.patch.object(M, 'view_scope', return_value=root), mock.patch.object(M, 'directory', scopes), \
                     mock.patch.object(M, 'view_prefix'), mock.patch.object(M, 'view_namespaces', return_value={}), \
                     mock.patch.object(M, 'view_mount_rows', return_value=[]), mock.patch.object(M.os, 'umask'), \
                     mock.patch.object(M.os, 'uname', return_value=SimpleNamespace(machine='x86_64')), \
                     mock.patch.object(M, 'view_proc', return_value=b'ID=ubuntu\nVERSION_ID="24.04"\n'), \
                     mock.patch.object(M, 'view_remove_root', side_effect=lambda *_: root.rmdir()) as remove:
                    report = M.view_run('123', 'a'*40, os.getuid(), os.getgid(), members, 'b'*64)
                self.assertEqual(report['failure'], 'root-setup')
                self.assertIs(report['cleanupComplete'], failed_scope is None)
                self.assertIs(report['workerAttempted'], False)
                self.assertEqual(remove.call_count, 0 if failed_scope in ('precreate', 'owned') else 1)
                self.assertIs(root.exists(), failed_scope == 'owned')

    def test_closed_worker_receipt_requires_every_physical_phase(self):
        value = {'phases': list(M.VIEW_PHASES), 'ipv6RejectRows': 1}
        self.assertEqual(M.view_worker_result(M.canonical(value)), value)
        for changed in ({'phases': value['phases'][1:]}, {'ipv6RejectRows': True}, {'ipv6RejectRows': 9},
                        {'unknown': 'fictional'}):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                M.view_worker_result(M.canonical(value | changed))

    def test_success_capture_requires_unchanged_release_scope_and_owned_settlement(self):
        process = {'reason': 'complete', 'commandExit': 0, 'admitted': True, 'reaped': True,
                   'groupQuiescent': True, 'escapedSession': False}
        worker = {'phases': list(M.VIEW_PHASES), 'ipv6RejectRows': 0}
        row = M.view_report(None, sha='a'*40, run='123', event='b'*64, process=process,
                            attempted=True, worker=worker, cleanup=True, elapsed=1234)
        self.assertEqual(M.validate_view_capture(M.canonical(row), '0'), row)
        for changed in ({'process': process | {'reaped': False}}, {'process': process | {'escapedSession': True}},
                        {'process': process | {'reason': 'deadline'}}, {'cleanupComplete': False},
                        {'releaseAuthorized': True}, {'worker': None}, {'elapsedMs': 25000}, {'workerAttempted': False}):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                M.validate_view_capture(M.canonical(row | changed), '0')
        with self.assertRaises(ValueError):
            M.validate_view_capture(M.canonical(row), '1')

    def test_refusal_capture_requires_original_unconfirmed_frontier(self):
        pre_root = M.view_report('pre-root')
        self.assertEqual(M.validate_view_capture(M.canonical(pre_root), '1'), pre_root)
        self.assertEqual(pre_root['unconfirmedPhases'], list(M.VIEW_PHASES))
        exit_row = {'reason': 'command-failed', 'commandExit': 43, 'admitted': True, 'reaped': True,
                    'groupQuiescent': True, 'escapedSession': False}
        native = M.view_report('network-route-census', sha='a'*40, run='123', event='b'*64, attempted=True,
                               process=exit_row, cleanup=True, elapsed=9)
        self.assertEqual(native['unconfirmedPhases'], list(M.VIEW_PHASES[3:]))
        self.assertEqual(M.validate_view_capture(M.canonical(native), '1'), native)
        for changed in ({'unconfirmedPhases': []}, {'process': None}, {'workerAttempted': False},
                        {'process': exit_row | {'commandExit': 42}}, {'process': exit_row | {'reason': 'deadline'}},
                        {'process': exit_row | {'admitted': False}}, {'process': exit_row | {'escapedSession': True}}):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                M.validate_view_capture(M.canonical(native | changed), '1')

    def test_refusal_credit_distinguishes_no_worker_unsettled_worker_and_successful_worker(self):
        provenance = {'sha': 'a'*40, 'run': '123', 'event': 'b'*64, 'elapsed': 9}
        success = {'reason': 'complete', 'commandExit': 0, 'admitted': True, 'reaped': True,
                   'groupQuiescent': True, 'escapedSession': False}
        worker = {'phases': list(M.VIEW_PHASES), 'ipv6RejectRows': 0}
        for row in (M.view_report('root-setup', cleanup=True, **provenance),
                    M.view_report('owned-worker', attempted=True, **provenance),
                    M.view_report('worker-receipt', attempted=True, process=success, cleanup=True, **provenance),
                    M.view_report('cleanup', attempted=True, process=success, worker=worker, **provenance)):
            self.assertEqual(M.validate_view_capture(M.canonical(row), '1'), row)
        timeout = success | {'reason': 'deadline', 'commandExit': -9, 'reaped': False, 'groupQuiescent': False}
        for row in (M.view_report('owned-worker', attempted=True, cleanup=True, **provenance),
                    M.view_report('owned-worker', attempted=True, process=timeout, cleanup=True, **provenance),
                    M.view_report('cleanup', attempted=True, process=timeout, worker=worker, **provenance),
                    M.view_report('cleanup', attempted=True, worker=worker, **provenance),
                    M.view_report('worker-receipt', attempted=True, process=timeout, **provenance),
                    M.view_report('root-setup', attempted=True, process=success, **provenance)):
            with self.subTest(row=row), self.assertRaises(ValueError):
                M.validate_view_capture(M.canonical(row), '1')

if __name__ == '__main__':
    unittest.main()
