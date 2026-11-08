"""Real disposable filesystem/digest controls; no root copy or native Next proof."""
import hashlib
import contextlib
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
OLD = load('frozen_format2_dependency_controls', ROOT / '.github/ci/fixtures/runtime-inventory-format2/build-bundle.py')


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
        return {'normalization': 'ROOT_COPY_DEPENDENCIES_V2',
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

    def sharp(self):
        package = self.modules / '.store/sharp'
        (package / 'node_modules/.bin').mkdir(parents=True)
        (package / 'package.json').write_text('{"name":"sharp","version":"0.35.5"}')
        cli = self.modules / '.store/semver/bin/semver.js'
        cli.parent.mkdir(parents=True)
        cli.write_bytes(b'// fictional semver CLI\n')
        (self.modules / 'sharp').symlink_to('.store/sharp')
        prefix = str(self.modules)
        raw = ('#!/bin/sh\nbasedir="fixture"\nif [ -z "$NODE_PATH" ]; then\n'
               '  export NODE_PATH="' + prefix + '/.store/semver/bin/node_modules:' + prefix + '/.store/semver/node_modules"\nelse\n'
               '  export NODE_PATH="' + prefix + '/.store/semver/bin/node_modules:' + prefix + '/.store/semver/node_modules:$NODE_PATH"\nfi\n'
               'if [ -x "$basedir/node" ]; then\n  exec "$basedir/node" "$basedir/../../../semver/bin/semver.js" "$@"\nelse\n'
               '  exec node "$basedir/../../../semver/bin/semver.js" "$@"\nfi\n').encode()
        shim = package / 'node_modules/.bin/semver'
        shim.write_bytes(raw)
        shim.chmod(0o755)
        return package, shim, raw

    def test_relocated_known_wrapper_matches_the_actual_unchanged_historical_format2_identity(self):
        _, shim, raw = self.sharp()
        expected, _ = OLD.package_identity(self.source, 'sharp')
        target = self.source.parent / 'copied-runtime'
        shutil.copytree(self.source, target, symlinks=True)
        # Reproduce the old copy seam with the actual frozen receiver comparator.
        with self.assertRaisesRegex(ValueError, 'does not belong to this runtime source'):
            OLD.package_identity(target, 'sharp', str(self.source))
        with mock.patch.object(P, 'RUNTIME_SOURCE', target):
            before = self.inventory()
            with I.PinnedTree(self.modules, require) as tree:
                key, original, projected = P.installer_projection(tree, self.source, I, require)
            self.assertEqual(original, raw)
            expected_bytes = raw.replace(str(self.modules).encode(), str(target / 'node_modules').encode())
            self.assertEqual(projected, expected_bytes)
            (target / 'node_modules' / key).write_bytes(projected)
            (target / 'node_modules' / key).chmod(0o755)
            self.assertEqual(self.inventory(target), before)
            self.assertEqual(OLD.package_identity(target, 'sharp', str(self.source))[0], expected)
            self.assertEqual(I.package_identity(target, 'sharp', str(self.source))[0], expected)
            self.assertEqual(shim.read_bytes(), raw)
        self.assertEqual((target / 'node_modules/.pnpm/pkg/index.js').read_bytes(), self.payload)
        self.assertEqual((target / 'node_modules/.pnpm/pkg/bin/run').stat().st_mode & 0o777, 0o755)

    def test_actual_output_write_uses_projected_bytes_and_retains_its_root_owner_refusal(self):
        self.assertNotEqual(os.getuid(), 0, 'This is an unprivileged source model, not native root acceptance')
        _, shim, raw = self.sharp()
        target = self.source.parent / 'private-output'
        target.mkdir(mode=0o700)
        with mock.patch.object(P, 'RUNTIME_SOURCE', target), I.PinnedTree(self.modules, require) as tree:
            key, original, projected = P.installer_projection(tree, self.source, I, require)
        # Exercise the real write method with a disposable descriptor adapter.
        # Its unchanged final uid0 guard MUST refuse; no root proof is fabricated.
        output = P.OwnedPackage.__new__(P.OwnedPackage)
        output.require, output.entries, output.bytes = require, 0, 0
        @contextlib.contextmanager
        def parent(_name):
            descriptor = os.open(target, os.O_RDONLY | os.O_DIRECTORY)
            try: yield descriptor, 'semver'
            finally: os.close(descriptor)
        output.parent = parent
        with shim.open('rb') as stream, self.assertRaisesRegex(ValueError, 'Native copied payload identity differs'):
            output.file('node_modules/' + key, stream, shim.stat(), 0o755, projection=(original, projected))
        self.assertEqual((target / 'semver').read_bytes(), projected)
        self.assertEqual((target / 'semver').stat().st_mode & 0o777, 0o755)
        self.assertNotIn(str(self.modules).encode(), projected)
        self.assertEqual(raw.count(str(self.modules).encode()), 4)

    def test_unknown_package_version_shape_prefix_sites_and_exec_targets_refuse(self):
        package, shim, raw = self.sharp()
        original_manifest = (package / 'package.json').read_bytes()
        cases = [raw.replace(b'#!/bin/sh', b'#!/bin/bash'), raw.replace(b'exec node ', b'exec foreign ', 1),
                 raw.replace(str(self.modules).encode(), b'/fictional/private/node_modules', 1),
                 raw + b'echo "' + str(self.modules).encode() + b'"\n',
                 raw.replace(b'/.store/semver/node_modules', b'/../outside', 1),
                 raw.replace(b':$NODE_PATH', b':$(private-command)', 1),
                 raw.replace(b'../../../semver/bin/semver.js', b'../../../../../../outside.js')]
        for value in cases:
            with self.subTest(shape=value[:24]):
                shim.write_bytes(value)
                with self.assertRaises((ValueError, FileNotFoundError)):
                    self.inventory()
        shim.write_bytes(raw)
        for value in (b'{"name":"sharp","version":"0.35.6"}', b'{"name":"foreign","version":"0.35.5"}'):
            (package / 'package.json').write_bytes(value)
            with self.assertRaises(ValueError): self.inventory()
        (package / 'package.json').write_bytes(original_manifest)
        shim.chmod(0o644)
        with self.assertRaises(ValueError): self.inventory()

    def test_copy_owner_admits_only_the_fixed_destination_and_the_same_projection(self):
        _, shim, raw = self.sharp()
        calls = []
        class Output:
            root = P.RUNTIME_SOURCE
            def directory(self, _name): pass
            def link(self, _name, _target): pass
            def file(self, name, stream, before, mode, projection=None):
                if name.endswith('/sharp/node_modules/.bin/semver'):
                    calls.append((stream.read(), before.st_size, mode, projection))
        P.copy_installed_dependencies(self.source, Output(), I, os.getuid(), require)
        self.assertEqual(len(calls), 1)
        original, size, mode, projection = calls[0]
        self.assertEqual((original, size, mode), (raw, len(raw), 0o755))
        self.assertEqual(projection, (raw, raw.replace(str(self.modules).encode(), str(P.RUNTIME_SOURCE / 'node_modules').encode())))
        other = Output()
        other.root = self.source.parent / 'foreign-runtime'
        with self.assertRaisesRegex(ValueError, 'fixed runtime destination'):
            P.copy_installed_dependencies(self.source, other, I, os.getuid(), require)


if __name__ == '__main__':
    unittest.main()
