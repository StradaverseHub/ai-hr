"""Synthetic stdlib controls only; no root seal, API, app or native acceptance."""
import base64
import copy
import hashlib
import importlib.util
import json
import os
import pathlib
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('binding_model', pathlib.Path(__file__).with_name('next_build_binding.py'))
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)


def fixture():
    expected = {'candidate': 'a'*40, 'controller': 'b'*40, 'runId': 123, 'controllerBranch': 'codex/native-fixture',
                'producerStartedAt': '2026-11-08T00:00:00Z', 'producerCompletedAt': '2026-11-08T00:01:00Z'}
    contents = {'system-testing.json': json.dumps({'format': 1, 'activeServiceVerified': False,
                'identity': {'sourceRef': expected['candidate'], 'buildRecordId': 'fixture-record'}}).encode(),
                'successful-build.json': b'{"syntheticOnly":true}', 'bytes/build-bundle.tar.gz': b'synthetic bytes, not an archive'}
    digest = lambda data: hashlib.sha256(data).hexdigest()
    manifest = {'format': 2, 'kind': 'next-build-byte-bundle', 'platform': 'linux', 'capacityProfile': M.CAPACITY,
                'nextBuildId': 'fixture-build', 'archiveBytes': len(contents['bytes/build-bundle.tar.gz']),
                'archiveSha256': digest(contents['bytes/build-bundle.tar.gz'])}
    contents['bytes/build-bundle-files.json'] = json.dumps(manifest).encode()
    provenance = {'format': 2, 'kind': 'ci-system-testing-build-candidate', 'releaseAuthorized': False,
                  'source': expected['candidate'], 'controller': expected['controller'], 'runId': 123, 'runAttempt': 1,
                  'repository': 'StradaverseHub/ai-hr', 'repositoryId': 1333414856,
                  'workflowRef': 'StradaverseHub/ai-hr/.github/workflows/alpha-staging.yml@refs/heads/codex/native-fixture',
                  'runtime': M.RUNTIME, 'capacityProfile': M.CAPACITY, 'nextBuildId': 'fixture-build',
                  'buildRecordId': 'fixture-record', 'buildSourcePath': '/home/runner/work/ai-hr/ai-hr/source',
                  'archiveBytes': manifest['archiveBytes'], 'archiveSha256': manifest['archiveSha256'],
                  'manifestSha256': digest(contents['bytes/build-bundle-files.json']),
                  'preparedSha256': digest(contents['system-testing.json']),
                  'successfulObservationSha256': digest(contents['successful-build.json'])}
    contents['build-provenance.json'] = json.dumps(provenance).encode()
    records = {path: {'bytes': data if not path.endswith('.tar.gz') else b'', 'size': len(data), 'sha256': digest(data)} for path, data in contents.items()}
    binding = {'schemaVersion': 1, 'kind': M.PLAIN_KIND, 'releaseAuthorized': False, 'expected': expected,
               'artifact': {'id': 456, 'digest': 'sha256:'+'c'*64, 'runId': 123}, 'producerJob': {'id': 789, 'name': 'build'},
               'packet': {'archiveSha256': provenance['archiveSha256'], 'manifestSha256': provenance['manifestSha256'],
                          'provenanceSha256': digest(contents['build-provenance.json']), 'nextBuildId': 'fixture-build'}}
    return binding, records, contents


class BindingModels(unittest.TestCase):
    def test_closed_owner_metadata_and_every_member_chain_are_required(self):
        binding, records, _ = fixture()
        args = ('a'*40, 'b'*40, '123', 'db-'+'d'*16, M.RUNNER_TEMP, 1001)
        reference = M.binding_fields(binding, *args, False)
        self.assertEqual(M.packet_fields(records, binding, reference)['nextBuildId'], 'fixture-build')
        for field, value in [('candidate', 'e'*40), ('controller', 'e'*40), ('runId', 124), ('controllerBranch', '../main')]:
            changed = copy.deepcopy(binding)
            changed['expected'][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                M.binding_fields(changed, *args, False)
        for path in M.MEMBERS:
            changed = copy.deepcopy(records)
            changed[path]['sha256'] = 'f'*64
            with self.subTest(path=path), self.assertRaises(ValueError):
                M.packet_fields(changed, binding, reference)
        for change in ({'releaseAuthorized': True}, {'rootSealed': True}):
            with self.assertRaises(ValueError):
                M.binding_fields(binding | change, *args, False)

    def test_sealed_kind_or_self_consistent_models_cannot_authorize_a_nonroot_reader(self):
        with mock.patch.object(M.os, 'geteuid', return_value=1001), self.assertRaisesRegex(ValueError, 'requires root'):
            M.read_native_build_binding('/var/lib/aihr-native-build/123/db-'+ 'd'*16+'/packet', '/fake',
                                        'a'*40, 'b'*40, '123', 'db-'+'d'*16, M.RUNNER_TEMP, 1001)
        with mock.patch.object(M.os, 'geteuid', return_value=0), self.assertRaisesRegex(ValueError, 'Fixed root-sealed'):
            M.read_native_build_binding('/home/runner/caller-packet', '/home/runner/caller-binding',
                                        'a'*40, 'b'*40, '123', 'db-'+'d'*16, M.RUNNER_TEMP, 1001)

    def test_helper_closure_is_finite_byte_bound_and_matches_both_hash_algorithms(self):
        helpers = {}
        for name, source in M.HELPERS.items():
            raw = ('# synthetic helper '+name+'\n').encode()
            helpers[name] = {'sourcePath': source, 'sha256': hashlib.sha256(raw).hexdigest(),
                             'gitBlobId': M.blob_id(raw), 'base64': base64.b64encode(raw).decode()}
        self.assertEqual(set(M.helper_fields(helpers, True)), set(M.HELPERS))
        for change in ('missing', 'extra', 'bytes', 'blob', 'path'):
            changed = copy.deepcopy(helpers)
            name = 'next_source.py'
            if change == 'missing':
                del changed[name]
            elif change == 'extra':
                changed['caller.py'] = changed[name]
            elif change == 'bytes':
                changed[name]['base64'] = base64.b64encode(b'foreign').decode()
            elif change == 'blob':
                changed[name]['gitBlobId'] = 'e'*40
            else:
                changed[name]['sourcePath'] = '/caller/executable.py'
            with self.subTest(change=change), self.assertRaises(ValueError):
                M.helper_fields(changed, True)

    def test_native_pr_expected_shape_is_separate_and_exact(self):
        binding, records, _ = fixture()
        binding['expected']['controllerRef'] = 'refs/pull/230/merge'
        binding['expected']['controllerBranch'] = 'feature/native'
        args = ('a'*40, 'b'*40, '123', 'db-'+'d'*16, M.RUNNER_TEMP, 1001)
        self.assertEqual(M.binding_fields(binding, *args, False), 'refs/pull/230/merge')
        with self.assertRaises(ValueError):
            M.packet_fields(records, binding, 'refs/pull/230/merge')
        binding['expected']['controllerRef'] = 'refs/heads/main'
        with self.assertRaises(ValueError):
            M.binding_fields(binding, *args, False)

    def test_descriptor_member_refuses_aliases_links_modes_bounds_and_concurrent_change(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            path = root/'member'
            path.write_bytes(b'exact fixture bytes')
            path.chmod(0o600)
            fd = os.open(root, os.O_RDONLY|os.O_DIRECTORY)
            try:
                original = M.member(fd, 'member', 100, os.getuid(), (0o600,))
                self.assertEqual(original['bytes'], b'exact fixture bytes')
                with self.assertRaises(ValueError):
                    M.member(fd, 'member', 2, os.getuid(), (0o600,))
                with self.assertRaises(ValueError):
                    M.member(fd, 'member', 100, os.getuid(), (0o400,))
                (root/'link').symlink_to(path)
                with self.assertRaises(ValueError):
                    M.member(fd, 'link', 100, os.getuid(), (0o600,))
                os.link(path, root/'hard')
                with self.assertRaises(ValueError):
                    M.member(fd, 'member', 100, os.getuid(), (0o600,))
                (root/'hard').unlink()
                read = os.read
                changed = False
                def mutate(descriptor, length):
                    nonlocal changed
                    value = read(descriptor, length)
                    if not changed:
                        changed = True
                        path.write_bytes(b'changed fixture bytes')
                    return value
                with mock.patch.object(M.os, 'read', side_effect=mutate), self.assertRaises(ValueError):
                    M.member(fd, 'member', 100, os.getuid(), (0o600,))
            finally:
                os.close(fd)


if __name__ == '__main__':
    unittest.main()
