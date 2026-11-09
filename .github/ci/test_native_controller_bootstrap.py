"""Disposable filesystem/source controls only; no sudo, mount, Git, Node or app."""
import hashlib
import importlib.util
import os
import pathlib
import tempfile
import unittest
from contextlib import nullcontext
from types import SimpleNamespace
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

    def test_pinned_node_capture_preserves_the_exact_probe_and_bytes(self):
        facts = {'node': '22.23.3', 'abi': '127', 'platform': 'linux', 'arch': 'x64', 'glibc': '2.39'}
        expression = ('JSON.stringify({node:process.versions.node,abi:process.versions.modules,'
                      'platform:process.platform,arch:process.arch,glibc:process.report.getReport().header.glibcVersionRuntime})')
        with tempfile.TemporaryDirectory() as folder:
            node = pathlib.Path(folder).resolve() / 'node'
            raw = b'\x7fELF fictional Node source model\n'
            node.write_bytes(raw)
            node.chmod(0o755)
            with mock.patch.object(M.shutil, 'which', return_value=str(node)) as which, \
                 mock.patch.object(M.subprocess, 'run', return_value=SimpleNamespace(stdout=M.canonical(facts))) as run:
                self.assertEqual(M._capture_pinned_node(), (node, raw))
                which.assert_called_once_with('node')
                run.assert_called_once_with([str(node), '-p', expression], env=M.SAFE, timeout=10,
                                            capture_output=True, check=True)
                run.return_value.stdout = M.canonical(facts | {'abi': '126'})
                with self.assertRaisesRegex(ValueError, 'Exact pinned setup-node runtime required'):
                    M._capture_pinned_node()

    def test_pinned_node_row_refuses_any_other_path_and_extra_fields(self):
        path = pathlib.Path('/opt/hostedtoolcache/node/22.23.3/x64/bin/node')
        row = {'path': str(path), 'bytes': 64, 'sha256': 'a'*64}
        with mock.patch.object(pathlib.Path, 'resolve', autospec=True, side_effect=lambda self: self):
            M._require_pinned_node_row(row)
            for changed in ({'path': '/usr/bin/node'}, {'args': []}, {'bytes': True}, {'sha256': 'a'*63}):
                with self.subTest(changed=changed), self.assertRaises(ValueError):
                    M._require_pinned_node_row(row | changed)
        with mock.patch.object(pathlib.Path, 'resolve', return_value=path.parent / 'replacement'):
            with self.assertRaisesRegex(ValueError, 'Exact pinned setup-node executable required'):
                M._require_pinned_node_row(row)

    def test_pinned_node_reread_uses_fixed_location_and_exact_owner_hash_and_elf(self):
        def row(raw):
            return {'path': str(M._PINNED_NODE_PATH), 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}

        with tempfile.TemporaryDirectory() as folder:
            model = pathlib.Path(folder).resolve()
            node = model / 'node'
            raw = b'\x7fELF fictional Node source model\n'
            node.write_bytes(raw)
            node.chmod(0o755)
            with M.directory(model) as source, mock.patch.object(M, 'directory', return_value=nullcontext(source)) as directory:
                self.assertEqual(M._read_pinned_node(row(raw), os.getuid()), raw)
                directory.assert_called_once_with(M._PINNED_NODE_PATH.parent)
                for changed in ({'bytes': len(raw) + 1}, {'sha256': '0'*64}):
                    with self.subTest(changed=changed), self.assertRaisesRegex(ValueError, 'Controller snapshot bytes changed'):
                        M._read_pinned_node(row(raw) | changed, os.getuid())
                with mock.patch.object(M, 'read', return_value=(raw, SimpleNamespace(st_uid=os.getuid() + 1))):
                    with self.assertRaisesRegex(ValueError, 'Actual installed Node ELF required'):
                        M._read_pinned_node(row(raw), os.getuid())
                foreign = b'fictional non-ELF bytes\n'
                node.write_bytes(foreign)
                with self.assertRaisesRegex(ValueError, 'Actual installed Node ELF required'):
                    M._read_pinned_node(row(foreign), os.getuid())

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


if __name__ == '__main__':
    unittest.main()
