"""Real disposable filesystem/digest controls; no root copy or native Next proof."""
import hashlib
import importlib.util
import json
import os
import pathlib
import shutil
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


P = load('package_inventory_controls', pathlib.Path(__file__).with_name('next_native_package.py'))
I = load('canonical_dependency_inventory_controls', ROOT / '.github/ci/runtime_inventory.py')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True) + '\n').encode()


class DependencyInventoryControls(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aihr-native-dependencies-model-')
        self.source = pathlib.Path(self.temp.name).resolve() / 'source'
        self.modules = self.source / 'node_modules'
        (self.modules / '.pnpm/pkg/bin').mkdir(parents=True)
        self.payload = b'module.exports=1;\n'
        (self.modules / '.pnpm/pkg/index.js').write_bytes(self.payload)
        (self.modules / '.pnpm/pkg/index.js').chmod(0o644)
        os.link(self.modules / '.pnpm/pkg/index.js', self.modules / 'same.js')
        (self.modules / '.pnpm/pkg/bin/run').write_bytes(b'#!/bin/false\n')
        (self.modules / '.pnpm/pkg/bin/run').chmod(0o755)
        (self.modules / '.pnpm/pkg/bin').chmod(0o555)
        (self.modules / 'pkg').symlink_to('.pnpm/pkg')
        (self.modules / 'unicode-测试').write_bytes('fictional 测试\n'.encode())
        (self.modules / 'unicode-测试').chmod(0o644)

    def tearDown(self):
        for parent, directories, _ in os.walk(self.temp.name, followlinks=False):
            os.chmod(parent, 0o755)
            for directory in directories:
                file = pathlib.Path(parent) / directory
                if not file.is_symlink():
                    file.chmod(0o755)
        self.temp.cleanup()

    def inventory(self, source=None):
        return P.semantic_dependency_inventory(source or self.source, I, os.getuid(), require)

    def expected(self):
        def file(path, data, mode=0o644):
            return {'path': path, 'kind': 'file', 'mode': mode, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
        rows = [{'path': path, 'kind': 'directory', 'mode': 0o755} for path in ('.pnpm', '.pnpm/pkg', '.pnpm/pkg/bin')]
        rows += [file('.pnpm/pkg/index.js', self.payload), file('same.js', self.payload),
                 file('.pnpm/pkg/bin/run', b'#!/bin/false\n', 0o755), file('unicode-测试', 'fictional 测试\n'.encode()),
                 {'path': 'pkg', 'kind': 'link', 'mode': 0o777, 'target': '.pnpm/pkg'}]
        return {'normalization': 'ROOT_COPY_DEPENDENCIES_V1',
                'sha256': hashlib.sha256(canonical(sorted(rows, key=lambda row: row['path']))).hexdigest(),
                'entries': 8, 'bytes': 2 * len(self.payload) + len(b'#!/bin/false\n') + len('fictional 测试\n'.encode())}

    def test_exact_independent_rows_and_equivalent_normalized_copy(self):
        expected = self.expected()
        self.assertEqual(self.inventory(), expected)
        target = self.source.parent / 'normalized-copy'
        shutil.copytree(self.source, target, symlinks=True)
        for parent, directories, _ in os.walk(target, followlinks=False):
            os.chmod(parent, 0o755)
            for directory in directories:
                path = pathlib.Path(parent) / directory
                if not path.is_symlink():
                    path.chmod(0o755)
        self.assertEqual((self.modules / 'same.js').stat().st_nlink, 2)
        self.assertEqual((target / 'node_modules/same.js').stat().st_nlink, 1)
        self.assertEqual(self.inventory(target), expected)

    def test_bytes_mode_and_link_identity_drift_change_the_expected_digest(self):
        expected = self.expected()
        executable = self.modules / '.pnpm/pkg/bin/run'
        executable.chmod(0o644)
        self.assertNotEqual(self.inventory()['sha256'], expected['sha256'])
        executable.chmod(0o755)
        original = self.modules / '.pnpm/pkg/index.js'
        original.write_bytes(b'module.exports=2;\n')
        self.assertNotEqual(self.inventory()['sha256'], expected['sha256'])
        original.write_bytes(self.payload)
        alias = self.modules / 'pkg'
        alias.unlink()
        alias.symlink_to('.pnpm/pkg/bin')
        self.assertNotEqual(self.inventory()['sha256'], expected['sha256'])

    def test_private_escaping_cyclic_special_and_writable_inputs_refuse(self):
        for kind in ('private', 'escape', 'absolute-in-root', 'cycle', 'fifo', 'writable-file', 'writable-directory'):
            with self.subTest(kind=kind):
                bad = self.modules / ('.npmrc' if kind == 'private' else 'bad')
                if kind in ('private', 'writable-file'):
                    bad.write_bytes(b'fictional')
                    bad.chmod(0o666 if kind == 'writable-file' else 0o644)
                elif kind in ('escape', 'absolute-in-root', 'cycle'):
                    bad.symlink_to('../../outside' if kind == 'escape' else str(self.modules / '.pnpm/pkg') if kind == 'absolute-in-root' else 'bad')
                elif kind == 'fifo':
                    os.mkfifo(bad)
                else:
                    bad.mkdir()
                    bad.chmod(0o777)
                try:
                    with self.assertRaises(ValueError):
                        self.inventory()
                finally:
                    if kind == 'writable-directory':
                        bad.rmdir()
                    else:
                        bad.unlink()

    def test_actual_mutation_after_read_is_not_a_valid_pre_candidate_snapshot(self):
        original = I.PinnedTree.assert_unchanged
        def changed(tree):
            (self.modules / 'unicode-测试').write_bytes(b'changed during capture')
            original(tree)
        with mock.patch.object(I.PinnedTree, 'assert_unchanged', changed), self.assertRaises(ValueError):
            self.inventory()

    def test_file_count_payload_and_metadata_work_bounds_are_enforced(self):
        for constant in ('MAX_ENTRIES', 'MAX_FILE', 'MAX_BYTES', 'MAX_METADATA'):
            with self.subTest(constant=constant), mock.patch.object(P, constant, 1), self.assertRaises(ValueError):
                self.inventory()


if __name__ == '__main__':
    unittest.main()
