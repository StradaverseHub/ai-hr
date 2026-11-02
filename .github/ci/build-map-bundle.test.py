"""Format-3 map-copy transport: synthetic bytes only, never a build or release."""
import copy
import errno
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tarfile
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


base = module('map_fixture_legacy', 'build-bundle.py')
maps = module('map_fixture_transport', 'build-map-bundle.py')
activation = module('map_fixture_activation', 'build-activate.py')


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False) + '\n').encode()


class MapBundleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='aihr-map-fixture-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.source, self.runtime = self.root/'source', self.root/'runtime'
        for root in [self.source, self.runtime]:
            root.mkdir()
            for name in ['sharp', 'fontkit']:
                package = root/'node_modules'/name
                package.mkdir(parents=True)
                (package/'package.json').write_text(json.dumps({'name': name, 'version': '1.2.3'}))
                (package/'index.js').write_bytes(b'module.exports = 1;\n')
        self.build = self.source/'.next'
        for name in ['server/app', 'static/chunks', 'node_modules', 'types']:
            (self.build/name).mkdir(parents=True)
        (self.build/'BUILD_ID').write_bytes(b'new-build\n')
        (self.build/'server/app/page.js').write_bytes(b'module.exports = 42;\n')
        for name in ['sharp', 'fontkit']:
            (self.build/'node_modules'/f'{name}-aaaaaaaa').symlink_to(self.source/'node_modules'/name, target_is_directory=True)
        # Independently authored incompressible bytes exceed DEFLATE's window: adjacent
        # copies still cost real archive bytes in the old format.
        self.payload = b''.join(hashlib.sha256(f'map-block-{i}'.encode()).digest() for i in range(8192))
        self.map_paths = ['server/app/a.js.map', 'server/app/b.js.map', 'static/chunks/z.js.map']
        for name in self.map_paths:
            (self.build/name).write_bytes(self.payload)
        (self.build/self.map_paths[1]).chmod(0o755)
        # Identical non-map data must remain physically transported, never deduplicated.
        (self.build/'static/chunks/identical.js').write_bytes(self.payload)
        self.output, self.destination = self.root/'packed', self.root/'received'
        self.active = self.runtime/'.next'
        self.active.mkdir()
        (self.active/'BUILD_ID').write_bytes(b'old-build\n')
        (self.active/'keep').write_bytes(b'old serving bytes')

    def packed(self):
        manifest = maps.pack(self.source, self.output)
        return manifest, self.output/'build-bundle.tar.gz', self.output/'build-bundle-files.json'

    def save(self, manifest, path):
        path.write_bytes(canonical(manifest))

    def rewrite_archive(self, manifest, archive, manifest_path, members):
        # Raw USTAR framing avoids tarfile silently translating a special header.
        body = bytearray()
        for info, data in members:
            body += info.tobuf(format=tarfile.USTAR_FORMAT)
            body += data + b'\0' * ((-len(data)) % 512)
        body += b'\0' * 1024
        with archive.open('wb') as raw, gzip.GzipFile(filename='', fileobj=raw, mode='wb', mtime=0) as stream:
            stream.write(body)
        manifest['archiveBytes'] = archive.stat().st_size
        manifest['archiveSha256'] = hashlib.sha256(archive.read_bytes()).hexdigest()
        self.save(manifest, manifest_path)

    def physical_members(self, manifest):
        omitted = {row['path'] for row in manifest['mapCopies']}
        result = []
        for row in manifest['files']:
            if row['path'] in omitted:
                continue
            info = tarfile.TarInfo(row['path'])
            info.size, info.mode = row['size'], row['mode']
            result.append((info, (self.build/row['path']).read_bytes()))
        return result

    def refuses(self, archive, manifest):
        with self.assertRaises((ValueError, OSError, tarfile.TarError, EOFError, UnicodeError)):
            maps.unpack(archive, manifest, self.destination, self.runtime)
        self.assertFalse(self.destination.exists())
        self.assertEqual((self.active/'BUILD_ID').read_bytes(), b'old-build\n')
        self.assertEqual((self.active/'keep').read_bytes(), b'old serving bytes')

    def test_lossless_maps_save_actual_archive_bytes_but_keep_independent_files(self):
        old = base.pack(self.source, self.root/'old-format')
        manifest, archive, path = self.packed()
        self.assertEqual(manifest['format'], 3)
        self.assertEqual(manifest['kind'], 'next-map-byte-bundle')
        self.assertEqual(set(manifest), set(old) | {'mapCopies'})
        self.assertEqual(manifest['mapCopies'], [
            {'path': 'server/app/b.js.map', 'source': 'server/app/a.js.map'},
            {'path': 'static/chunks/z.js.map', 'source': 'server/app/a.js.map'},
        ])
        for key in ['files', 'directories', 'aliases', 'unpackedBytes', 'capacityProfile', 'nextBuildId']:
            self.assertEqual(manifest[key], old[key])
        self.assertLess(manifest['archiveBytes'], old['archiveBytes'] - len(self.payload))
        with tarfile.open(archive, 'r:gz') as tar:
            members = tar.getmembers()
            self.assertTrue(all(row.type == tarfile.REGTYPE and not row.linkname for row in members))
            names = {row.name for row in members}
        self.assertEqual(names, {row['path'] for row in manifest['files']} - {self.map_paths[1], self.map_paths[2]})
        self.assertIn('static/chunks/identical.js', names)
        self.assertEqual(maps.unpack(archive, path, self.destination, self.runtime), manifest)
        for row in manifest['files']:
            actual = self.destination/row['path']
            self.assertEqual(actual.read_bytes(), (self.build/row['path']).read_bytes())
            self.assertEqual(hashlib.sha256(actual.read_bytes()).hexdigest(), row['sha256'])
            self.assertEqual(stat.S_IMODE(actual.stat().st_mode), row['mode'])
            self.assertEqual(actual.stat().st_nlink, 1)
        self.assertEqual(len({(self.destination/name).stat().st_ino for name in self.map_paths}), 3)
        self.assertEqual(maps.verify_directory(self.destination, path, self.runtime), manifest)
        # A copied map is still independently authenticated after reconstruction.
        (self.destination/self.map_paths[1]).write_bytes(b'tampered duplicate')
        with self.assertRaises(ValueError):
            maps.verify_directory(self.destination, path, self.runtime)
        self.assertEqual((self.destination/self.map_paths[0]).read_bytes(), self.payload)

    def test_pack_is_deterministic_and_formats_cannot_be_confused(self):
        manifest, archive, path = self.packed()
        other = self.root/'repeat'
        self.assertEqual(maps.pack(self.source, other), manifest)
        self.assertEqual((other/archive.name).read_bytes(), archive.read_bytes())
        self.assertEqual((other/path.name).read_bytes(), path.read_bytes())
        with self.assertRaises(ValueError):
            base.read_manifest(path)
        base.pack(self.source, self.root/'legacy')
        with self.assertRaises(ValueError):
            maps.read_manifest(self.root/'legacy'/path.name)

    def test_nonprimary_map_change_after_prehash_refuses_and_cleans_only_new_output(self):
        original_order = maps.base.compression_order
        observed = []

        def change_duplicate_before_tar_order(files):
            if not observed:
                observed.append(True)
                duplicate = self.build/self.map_paths[1]
                data = duplicate.read_bytes()
                duplicate.write_bytes(bytes([data[0] ^ 1]) + data[1:])
                self.assertEqual(duplicate.stat().st_size, len(self.payload))
            return original_order(files)

        with mock.patch.object(maps.base, 'compression_order', side_effect=change_duplicate_before_tar_order):
            with self.assertRaises((ValueError, OSError)):
                maps.pack(self.source, self.output)
        self.assertTrue(observed, 'mutation must reach the post-prehash ordering seam')
        self.assertFalse(self.output.exists())
        self.assertEqual((self.active/'BUILD_ID').read_bytes(), b'old-build\n')
        self.assertEqual((self.active/'keep').read_bytes(), b'old serving bytes')

    def test_copy_table_must_be_exact_canonical_map_only_no_chains_or_forward_references(self):
        original, archive, path = self.packed()
        variants = [
            [], list(reversed(original['mapCopies'])),
            [{'path': self.map_paths[1], 'source': self.map_paths[2]}, original['mapCopies'][1]],
            [original['mapCopies'][0], {'path': self.map_paths[2], 'source': self.map_paths[1]}],
            [{'path': self.map_paths[1], 'source': self.map_paths[2]}, {'path': self.map_paths[2], 'source': self.map_paths[1]}],
            [{'path': self.map_paths[1], 'source': self.map_paths[1]}, original['mapCopies'][1]],
            [{'path': 'static/chunks/identical.js', 'source': self.map_paths[0]}],
            [{'path': self.map_paths[1], 'source': '../outside.map'}],
            original['mapCopies'] + [original['mapCopies'][0]],
        ]
        for copies in variants:
            with self.subTest(copies=copies):
                manifest = copy.deepcopy(original)
                manifest['mapCopies'] = copies
                self.save(manifest, path)
                with self.assertRaises(ValueError):
                    maps.read_manifest(path)
        manifest = copy.deepcopy(original)
        next(row for row in manifest['files'] if row['path'] == self.map_paths[1])['sha256'] = '0'*64
        self.save(manifest, path)
        with self.assertRaises(ValueError):
            maps.read_manifest(path)

    def test_manifest_canonical_json_and_logical_expansion_bound(self):
        original, archive, path = self.packed()
        for data in [json.dumps(original).encode(), b'{"format":3,' + canonical(original)[1:]]:
            path.write_bytes(data)
            with self.assertRaises(ValueError):
                maps.read_manifest(path)
        bomb = copy.deepcopy(original)
        keep = next(row for row in bomb['files'] if row['path'] == 'BUILD_ID')
        rows = [{'path': f'server/app/bomb-{i:02}.map', 'size': base.MAX_FILE, 'sha256': '1'*64, 'mode': 0o644} for i in range(9)]
        bomb['files'] = [keep] + rows
        bomb['mapCopies'] = [{'path': row['path'], 'source': rows[0]['path']} for row in rows[1:]]
        bomb['unpackedBytes'] = sum(row['size'] for row in bomb['files'])
        self.assertGreater(bomb['unpackedBytes'], base.MAX_UNPACKED)
        self.save(bomb, path)
        with self.assertRaises(ValueError):
            maps.read_manifest(path)

    def test_rebound_archive_cannot_change_primary_missing_extra_or_special_members(self):
        original, archive, path = self.packed()
        members = self.physical_members(original)
        primary = next(i for i, (info, _) in enumerate(members) if info.name == self.map_paths[0])
        for kind in ['corrupt-primary', 'missing', 'extra', 'duplicate', 'copied-map-payload', 'hardlink', 'symlink', 'pax', 'gnu-longname', 'fifo']:
            with self.subTest(kind=kind):
                current = copy.deepcopy(members)
                if kind == 'corrupt-primary':
                    info, data = current[primary]
                    current[primary] = info, bytes([data[0] ^ 1]) + data[1:]
                elif kind == 'missing':
                    current.pop(primary)
                elif kind == 'extra':
                    info = tarfile.TarInfo('server/app/unexpected.js')
                    current.append((info, b''))
                elif kind == 'duplicate':
                    current.append(copy.deepcopy(current[primary]))
                elif kind == 'copied-map-payload':
                    # Even correct bytes and rebound archive hashes cannot introduce an
                    # independent physical body for a destination declared as a map copy.
                    row = next(row for row in original['files'] if row['path'] == self.map_paths[1])
                    info = tarfile.TarInfo(row['path'])
                    info.size, info.mode = row['size'], row['mode']
                    current.append((info, self.payload))
                else:
                    info, data = current[primary]
                    info.type = {'hardlink': tarfile.LNKTYPE, 'symlink': tarfile.SYMTYPE, 'pax': tarfile.XHDTYPE,
                                 'gnu-longname': tarfile.GNUTYPE_LONGNAME, 'fifo': tarfile.FIFOTYPE}[kind]
                    info.size = 0
                    info.linkname = self.map_paths[1] if kind in ['hardlink', 'symlink'] else ''
                    current[primary] = info, b''
                manifest = copy.deepcopy(original)
                self.rewrite_archive(manifest, archive, path, current)
                self.refuses(archive, path)

    def test_dependency_identity_alias_and_private_payload_boundaries_remain(self):
        manifest, archive, path = self.packed()
        package = self.runtime/'node_modules/sharp/package.json'
        package.write_text(json.dumps({'name': 'sharp', 'version': '9.9.9'}))
        self.refuses(archive, path)
        package.write_text(json.dumps({'name': 'sharp', 'version': '1.2.3'}))
        manifest['aliases'][0]['path'] = 'node_modules/unsupported-aaaaaaaa'
        self.save(manifest, path)
        self.refuses(archive, path)
        private = self.build/'server/.env.private'
        private.write_bytes(b'PRIVATE_FIXTURE_NEVER_TRANSPORT')
        with self.assertRaises(ValueError) as caught:
            maps.pack(self.source, self.root/'private-output')
        self.assertNotIn('PRIVATE_FIXTURE_NEVER_TRANSPORT', str(caught.exception))
        self.assertNotIn(str(self.root), str(caught.exception))

    def test_existing_output_and_destination_are_never_overwritten_or_cleaned(self):
        manifest, archive, path = self.packed()
        with self.assertRaises((ValueError, OSError)):
            maps.pack(self.source, self.output)
        self.assertEqual(maps.read_manifest(path), manifest)
        self.destination.mkdir()
        (self.destination/'foreign').write_bytes(b'keep foreign directory')
        with self.assertRaises((ValueError, OSError)):
            maps.unpack(archive, path, self.destination, self.runtime)
        self.assertEqual((self.destination/'foreign').read_bytes(), b'keep foreign directory')
        link = self.root/'linked-destination'
        link.symlink_to(self.destination, target_is_directory=True)
        with self.assertRaises((ValueError, OSError)):
            maps.unpack(archive, path, link, self.runtime)
        self.assertTrue(link.is_symlink())
        self.assertEqual((self.active/'BUILD_ID').read_bytes(), b'old-build\n')

    def test_duplicate_copy_disk_full_interruption_and_foreign_replacement_preserve_serving_tree(self):
        manifest, archive, path = self.packed()
        original_open, original_os_open = Path.open, os.open
        for problem in ['disk-full', 'interruption', 'replaced-output']:
            with self.subTest(problem=problem):
                self.destination = self.root/f'received-{problem}'
                moved = self.root/'retained-incomplete'
                observed = []

                def inject(candidate):
                    if Path(candidate) != self.destination/self.map_paths[1]:
                        return
                    observed.append(True)
                    if problem == 'replaced-output':
                        self.destination.rename(moved)
                        self.destination.mkdir(mode=0o700)
                        (self.destination/'foreign').write_bytes(b'keep foreign replacement')
                    if problem == 'interruption':
                        raise KeyboardInterrupt('synthetic copy interruption')
                    raise OSError(errno.ENOSPC, 'synthetic copy disk full')

                def path_open(file, mode='r', *args, **kwargs):
                    if any(flag in mode for flag in ['w', 'x', 'a']):
                        inject(file)
                    return original_open(file, mode, *args, **kwargs)

                def os_open(file, flags, *args, **kwargs):
                    if isinstance(file, (str, bytes, os.PathLike)) and flags & (os.O_WRONLY | os.O_RDWR):
                        inject(os.fsdecode(file))
                    return original_os_open(file, flags, *args, **kwargs)

                with mock.patch.object(Path, 'open', path_open), mock.patch.object(os, 'open', os_open):
                    with self.assertRaises((OSError, KeyboardInterrupt)):
                        maps.unpack(archive, path, self.destination, self.runtime)
                self.assertTrue(observed, 'failure must reach duplicate reconstruction, not an earlier refusal')
                self.assertEqual((self.active/'BUILD_ID').read_bytes(), b'old-build\n')
                self.assertEqual((self.active/'keep').read_bytes(), b'old serving bytes')
                if problem == 'replaced-output':
                    self.assertEqual((self.destination/'foreign').read_bytes(), b'keep foreign replacement')
                    self.assertTrue((moved/'BUILD_ID').exists())
                else:
                    self.assertFalse(self.destination.exists())

    def test_copied_destination_readback_detects_postwrite_corruption(self):
        manifest, archive, path = self.packed()
        original_chmod = maps.os.chmod
        observed = []
        copied = self.destination/self.map_paths[1]

        def corrupt_after_chmod(file, mode, *args, **kwargs):
            result = original_chmod(file, mode, *args, **kwargs)
            if Path(file) == copied and not observed:
                observed.append(True)
                data = copied.read_bytes()
                self.assertEqual(data, self.payload)
                copied.write_bytes(bytes([data[0] ^ 1]) + data[1:])
                self.assertEqual(copied.stat().st_size, len(self.payload))
            return result

        with mock.patch.object(maps.os, 'chmod', side_effect=corrupt_after_chmod):
            with self.assertRaises((ValueError, OSError)):
                maps.unpack(archive, path, self.destination, self.runtime)
        self.assertTrue(observed, 'corruption must occur after the actual duplicate write and chmod')
        self.assertFalse(self.destination.exists())
        self.assertEqual((self.build/self.map_paths[0]).read_bytes(), self.payload)
        self.assertEqual((self.active/'BUILD_ID').read_bytes(), b'old-build\n')
        self.assertEqual((self.active/'keep').read_bytes(), b'old serving bytes')

    @unittest.skipUnless(sys.platform == 'linux', 'actual atomic activation fixture requires Linux')
    def test_extracted_maps_survive_actual_atomic_activate_and_rollback(self):
        manifest, archive, path = self.packed()
        stage = self.root/'stage'
        stage.mkdir(mode=0o700)
        staged = stage/'next'
        maps.unpack(archive, path, staged, self.runtime)
        old_inode, new_inode = self.active.stat().st_ino, staged.stat().st_ino
        result = activation.activate(staged, self.runtime, 'new-build', 'old-build')
        self.assertEqual(result['activeBuildId'], 'new-build')
        self.assertFalse(result['releaseAuthorized'])
        self.assertEqual(self.active.stat().st_ino, new_inode)
        self.assertEqual((self.active/self.map_paths[1]).read_bytes(), self.payload)
        self.assertEqual(maps.verify_directory(self.active, path, self.runtime), manifest)
        rollback = activation.activate(staged, self.runtime, 'old-build', 'new-build', action='rollback')
        self.assertEqual(rollback['activeBuildId'], 'old-build')
        self.assertFalse(rollback['serviceRestarted'])
        self.assertEqual(self.active.stat().st_ino, old_inode)
        self.assertEqual(staged.stat().st_ino, new_inode)
        self.assertEqual((self.active/'keep').read_bytes(), b'old serving bytes')
        self.assertEqual(maps.verify_directory(staged, path, self.runtime), manifest)


if __name__ == '__main__':
    unittest.main()
