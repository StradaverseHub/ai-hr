"""Private filesystem models with fictional pins. No transfer or tool execution."""
import gzip
import hashlib
import io
import json
import os
from contextlib import contextmanager
from pathlib import Path
import stat
import sys
import tarfile
import tempfile
import time
from types import ModuleType
import unittest
from unittest.mock import Mock, patch


def load_source(name, sibling):
    path = Path(__file__).with_name(sibling)
    module = ModuleType(name)
    module.__file__ = str(path)
    sys.modules[name] = module
    exec(compile(path.read_bytes(), str(path), 'exec', dont_inherit=True), module.__dict__)
    return module


I = load_source('tool_installation_model', 'native-workload-browser-tool-installation.py')
F = load_source('tool_installation_archive_fixtures', 'native-workload-browser-toolchain.test.py')
T = I._PARSER
BROWSER = 'chromium/chrome-headless-shell-linux64'
EXECUTABLE = BROWSER + '/chrome-headless-shell'


def sha(data):
    return hashlib.sha256(data).hexdigest()


class PrivateToolInstallationModels(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.root = self.base / 'private-tree'
        self.root.mkdir(mode=0o700)
        self.elf = F.example_elf()
        self.big = bytes(range(256)) * 1100
        self.browser = F.zipped([
            (F.ELF, self.elf, {'mode': stat.S_IFREG | 0o755, 'descriptor':'signed'}),
            (F.ROOT + b'/locales/model', self.big, {'descriptor':'unsigned'}),
            (F.ROOT + b'/zero', b'', {'method':0}),
        ])
        arc_root = F.ROOT.decode()
        rows = [
            (arc_root, 'directory', 0o555, 0, None),
            (arc_root + '/chrome-headless-shell', 'file', 0o555, len(self.elf), sha(self.elf)),
            (arc_root + '/locales', 'directory', 0o555, 0, None),
            (arc_root + '/locales/model', 'file', 0o444, len(self.big), sha(self.big)),
            (arc_root + '/zero', 'file', 0o444, 0, sha(b'')),
        ]
        self.browser_pins = {
            'BROWSER_ARCHIVE_BYTES': len(self.browser), 'BROWSER_ARCHIVE_SHA': sha(self.browser),
            'BROWSER_ARCHIVE_FILES': 3, 'BROWSER_TREE_ENTRIES': len(rows),
            'BROWSER_EXPANDED_BYTES': len(self.elf) + len(self.big),
            'BROWSER_TREE_SHA': sha(T.canonical(rows)),
            'BROWSER_EXECUTABLE_BYTES': len(self.elf), 'BROWSER_EXECUTABLE_SHA': sha(self.elf),
        }
        self.packages, self.package_pins, self.expected = {}, {}, {
            EXECUTABLE: self.elf, BROWSER + '/locales/model': self.big, BROWSER + '/zero': b'',
        }
        for name in ('playwright', 'playwright-core', 'postgres'):
            version, members = F.model_package(name)
            self.expected.update({'node_modules/' + name + path[len('package'):]: data for path, data in members})
            if name == 'playwright':
                members.append(('package/empty', b'', tarfile.DIRTYPE, 0o755))
            self.packages[name] = gzip.compress(F.raw_tar(members), mtime=0)
            self.package_pins[name] = version, F.sri(self.packages[name])

    @contextmanager
    def held(self, path=None):
        fd = os.open(path if path is not None else self.root, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            yield fd
        finally:
            os.close(fd)

    def run_materializer(self, fd, *, browser=None, deadline=None):
        sources = (self.packages[name] for name in ('playwright', 'playwright-core', 'postgres'))
        with patch.multiple(T, **self.browser_pins), patch.dict(T.PACKAGES, self.package_pins):
            return I.materialize_toolchain(fd, io.BytesIO(self.browser if browser is None else browser),
                                           *(io.BytesIO(source) for source in sources),
                                           time.monotonic() + 5 if deadline is None else deadline)

    def test_fixed_four_archive_bytes_and_staging_modes_reconcile_every_installed_member(self):
        with self.held() as fd:
            before = os.fstat(fd)
            result = self.run_materializer(fd)
            self.assertEqual((os.fstat(fd).st_dev, os.fstat(fd).st_ino), (before.st_dev, before.st_ino))
        self.assertIsInstance(result, tuple)
        expected_dirs = {'node_modules/playwright/empty'}
        for path in self.expected:
            expected_dirs.update(str(parent) for parent in Path(path).parents if str(parent) != '.')
        self.assertEqual([row.path for row in result], sorted(self.expected.keys() | expected_dirs))
        self.assertEqual({path.relative_to(self.root).as_posix() for path in self.root.rglob('*')},
                         self.expected.keys() | expected_dirs)
        for row in result:
            target = self.root / row.path
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), row.staged_mode)
            if row.path in expected_dirs:
                self.assertTrue(target.is_dir())
                self.assertEqual((row.kind, row.staged_mode, row.bytes, row.sha256, row.archive_mode),
                                 ('directory', 0o700, 0, None, 0o555))
            else:
                data = self.expected[row.path]
                self.assertEqual(target.read_bytes(), data)
                self.assertEqual((row.kind, row.staged_mode, row.bytes, row.sha256, row.archive_mode),
                                 ('file', 0o600, len(data), sha(data), 0o555 if row.path == EXECUTABLE else 0o444))

    def test_foreign_entry_or_symlink_refuses_before_mutating_held_root(self):
        foreign = self.base / 'outside'
        foreign.write_bytes(b'foreign')
        link = self.root / 'chromium'
        link.symlink_to(foreign)
        with self.held() as fd, self.assertRaisesRegex(T.ArchiveRefused, 'not empty'):
            self.run_materializer(fd)
        self.assertEqual(list(self.root.iterdir()), [link])
        self.assertTrue(link.is_symlink())
        self.assertEqual(foreign.read_bytes(), b'foreign')

    def test_wrong_root_kind_or_mode_refuses_before_any_archive_read(self):
        foreign = self.base / 'file'
        foreign.write_bytes(b'foreign')
        self.root.chmod(0o755)
        for path in (self.root, foreign):
            with self.subTest(path=path.name), self.held(path) as fd, \
                 patch.object(T, '_inspect_chromium') as parser, self.assertRaisesRegex(T.ArchiveRefused, 'directory mode'):
                self.run_materializer(fd)
            parser.assert_not_called()
        self.assertEqual(list(self.root.iterdir()), [])
        self.assertEqual(foreign.read_bytes(), b'foreign')

    def test_unpinned_browser_refuses_before_creating_staged_outputs(self):
        invalid = self.browser[:-1] + bytes((self.browser[-1] ^ 1,))
        with self.held() as fd, self.assertRaisesRegex(T.ArchiveRefused, 'pinned browser archive SHA-256'):
            self.run_materializer(fd, browser=invalid)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_valid_sri_with_late_bad_tar_padding_never_returns_a_tree(self):
        name = 'postgres'
        version, members = F.model_package(name)
        bad = gzip.compress(F.raw_tar(members) + b'\x01' + bytes(511), mtime=0)
        self.packages[name] = bad
        self.package_pins[name] = version, F.sri(bad)
        with self.held() as fd, self.assertRaisesRegex(T.ArchiveRefused, 'trailing tar content'):
            self.run_materializer(fd)
        self.assertEqual((self.root / EXECUTABLE).read_bytes(), self.elf)
        self.assertEqual((self.root / 'node_modules/postgres/src/index.js').read_bytes(),
                         self.expected['node_modules/postgres/src/index.js'])
        self.assertTrue(all(stat.S_IMODE(path.stat().st_mode) == 0o600
                            for path in self.root.rglob('*') if path.is_file()))

    def test_file_ancestor_collision_never_opens_a_conflicting_path(self):
        name = 'playwright'
        version, members = F.model_package(name)
        members.extend((('package/collision', b'kept'), ('package/collision/child', b'refused')))
        raw = gzip.compress(F.raw_tar(members), mtime=0)
        self.packages[name] = raw
        self.package_pins[name] = version, F.sri(raw)
        with self.held() as fd, self.assertRaisesRegex(T.ArchiveRefused, 'file conflicts with directory'):
            self.run_materializer(fd)
        self.assertEqual((self.root / 'node_modules/playwright/collision').read_bytes(), b'kept')

    def test_entry_bound_counts_implicit_directories_before_creating_file(self):
        with self.held() as fd, patch.object(I, '_MAX_ENTRIES', 2), \
             self.assertRaisesRegex(T.ArchiveRefused, 'tree entry bound'):
            self.run_materializer(fd)
        self.assertEqual({path.relative_to(self.root).as_posix() for path in self.root.rglob('*')},
                         {'chromium', BROWSER})
        self.assertTrue((self.root / BROWSER).is_dir())
        self.assertFalse((self.root / EXECUTABLE).exists())

    def test_actual_readback_rejects_same_size_change_replacement_and_extra_name(self):
        verify = I._PrivateTree.verify

        def change(owner, expected):
            target = self.root / EXECUTABLE
            if mutation == 'bytes':
                target.write_bytes(b'x' + self.elf[1:])
            elif mutation == 'inode':
                extra = self.root / 'replacement'
                extra.write_bytes(self.elf)
                extra.chmod(0o600)
                os.replace(extra, target)
            else:
                (self.root / 'extra').write_bytes(b'extra')
            return verify(owner, expected)

        for mutation, reason in [('bytes','content differs'), ('inode','file identity'), ('extra','unexpected tree entry')]:
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory(dir=self.base) as private:
                self.root = Path(private)
                with self.held() as fd, patch.object(I._PrivateTree, 'verify', change), self.assertRaisesRegex(T.ArchiveRefused, reason):
                    self.run_materializer(fd)

    def test_hardlink_and_symlink_refuse_readback_without_touching_external_bytes(self):
        verify = I._PrivateTree.verify
        foreign = self.base / 'outside'

        def link(owner, expected):
            target = self.root / EXECUTABLE
            if hardlink:
                os.link(target, foreign)
            else:
                target.unlink()
                target.symlink_to(foreign)
            return verify(owner, expected)

        for hardlink in (True, False):
            with self.subTest(hardlink=hardlink), tempfile.TemporaryDirectory(dir=self.base) as private:
                self.root = Path(private)
                with self.held() as fd, patch.object(I._PrivateTree, 'verify', link), \
                     self.assertRaisesRegex(T.ArchiveRefused, 'type, mode or link count'):
                    self.run_materializer(fd)
                self.assertEqual(foreign.read_bytes(), self.elf)

    def test_elapsed_deadline_refuses_initially_and_after_complete_filesystem_readback(self):
        start = time.monotonic()
        verify = I._PrivateTree.verify
        clock = Mock(return_value=start)

        def closes(owner, expected):
            observed = verify(owner, expected)
            clock.return_value = start + 1
            return observed

        with self.held() as fd, patch.object(T.time, 'monotonic', clock):
            with self.assertRaisesRegex(T.ArchiveRefused, 'deadline exhausted'):
                self.run_materializer(fd, deadline=start)
            self.assertEqual(list(self.root.iterdir()), [])
            with patch.object(I._PrivateTree, 'verify', closes), self.assertRaisesRegex(T.ArchiveRefused, 'deadline exhausted'):
                self.run_materializer(fd, deadline=start + 1)
            self.assertEqual((self.root / EXECUTABLE).read_bytes(), self.elf)


    def synthetic_projection(self):
        files = {name: data for name, data in self.expected.items() if not name.startswith('node_modules/postgres/')}
        dirs = {'node_modules/playwright/empty'}
        for name in files:
            dirs.update(str(parent) for parent in Path(name).parents if str(parent) != '.')
        rows = sorted([(name, 'directory', 0o555, 0, None) for name in dirs] + [
            (name, 'file', 0o555 if name == EXECUTABLE else 0o444, len(data), sha(data))
            for name, data in files.items()
        ])
        canonical = (json.dumps(rows, separators=(',', ':'), ensure_ascii=True) + '\n').encode()
        return rows, {'_SYNTHETIC_ENTRIES': len(rows), '_SYNTHETIC_BYTES': sum(row[3] for row in rows),
                      '_SYNTHETIC_SHA': sha(canonical)}

    @contextmanager
    def synthetic(self, fd, **projection):
        _, expected = self.synthetic_projection()
        sources = tuple(io.BytesIO(value) for value in (self.browser, *(self.packages[name] for name in (
            'playwright', 'playwright-core', 'postgres'))))
        with patch.multiple(I, **(expected | projection)), patch.multiple(T, **self.browser_pins), \
             patch.dict(T.PACKAGES, self.package_pins), I.synthetic_tool_stage(fd, time.monotonic() + 5) as stage:
            yield stage, sources

    def test_synthetic_stage_checks_four_inputs_and_returns_only_verified_browser_births(self):
        rows, _ = self.synthetic_projection()
        with self.held() as fd, self.synthetic(fd) as (stage, sources), \
             patch.object(T, '_inspect_package', wraps=T._inspect_package) as inspect:
            observed = stage.materialize(*sources)
            self.assertEqual(observed.root_state, I._state(os.fstat(fd)))
            snapshot = stage.journal()
            self.assertIsNone(snapshot.pending)
            self.assertEqual(snapshot.root_birth, I._birth(os.fstat(fd))[:2])
            self.assertEqual([(r.path, r.kind, r.archive_mode, r.bytes, r.sha256) for r in observed.members], rows)
            self.assertEqual(observed.member_states, tuple((name, I._state((self.root / name).lstat()))
                                                          for name, *_ in rows))
            births = {name: (kind, birth) for name, kind, birth in snapshot.created}
            self.assertEqual(len(snapshot.created), len(rows))
            self.assertEqual(births, {name: (kind, I._birth((self.root / name).lstat())[:2])
                                      for name, kind, *_ in rows})
            self.assertFalse((self.root / 'node_modules/postgres').exists())
            with self.assertRaisesRegex(T.ArchiveRefused, 'not fresh'):
                stage.materialize(*sources)
            names = ('playwright', 'playwright-core', 'postgres')
            self.assertEqual([c.args[0] for c in inspect.call_args_list], list(names))
            self.assertEqual([c.args[1] for c in inspect.call_args_list], list(sources[1:]))
            remaining = T.PACKAGE_COUNT_MAX
            for call, name in zip(inspect.call_args_list, names, strict=True):
                self.assertEqual(call.args[3], remaining)
                if name == 'postgres':
                    self.assertIsNone(call.args[4])
                else:
                    self.assertTrue(callable(call.args[4]))
                    prefix = 'node_modules/' + name
                    remaining -= sum(path == prefix or path.startswith(prefix + '/') for path, *_ in rows)
        self.assertEqual(stage.journal(), snapshot)
        with self.assertRaises(AttributeError):
            snapshot.pending = ('other', 'file')

    def test_synthetic_stage_refuses_unwritten_postgres_lock_framing_and_entrypoint(self):
        version, members = F.model_package('postgres')
        valid = self.packages['postgres']
        malformed = gzip.compress(F.raw_tar(members) + b'\x01' + bytes(511), mtime=0)
        missing = gzip.compress(F.raw_tar([row for row in members if row[0] != 'package/src/index.js']), mtime=0)
        for raw, integrity, reason in ((valid[:-1] + bytes((valid[-1] ^ 1,)), F.sri(valid), 'locked package SHA-512'),
                                       (malformed, F.sri(malformed), 'trailing tar content'),
                                       (missing, F.sri(missing), 'entrypoint file missing')):
            with self.subTest(reason=reason), tempfile.TemporaryDirectory(dir=self.base) as private:
                self.root = Path(private)
                self.packages['postgres'], self.package_pins['postgres'] = raw, (version, integrity)
                with self.held() as fd, self.synthetic(fd) as (stage, sources):
                    with self.assertRaisesRegex(T.ArchiveRefused, reason):
                        stage.materialize(*sources)
                self.assertFalse((self.root / 'node_modules/postgres').exists())
                self.assertTrue(stage.journal().created)
                self.assertIsNone(stage.journal().pending)
                self.assertFalse(any(name.startswith('node_modules/postgres') for name, *_ in stage.journal().created))

    def test_synthetic_abort_keeps_known_file_birth_after_partial_write(self):
        write = os.write

        def interrupt(fd, block):
            write(fd, block[:1])
            raise InterruptedError('fixture write interruption')

        with self.held() as fd, self.synthetic(fd) as (stage, sources):
            with patch.object(I.os, 'write', side_effect=interrupt), \
                 self.assertRaisesRegex(InterruptedError, 'fixture write interruption'):
                stage.materialize(*sources)
            with self.assertRaisesRegex(T.ArchiveRefused, 'not fresh'):
                stage.materialize(*sources)
        actual = (self.root / EXECUTABLE).stat()
        self.assertEqual(actual.st_size, 1)
        self.assertIn((EXECUTABLE, 'file', (actual.st_dev, actual.st_ino)), stage.journal().created)
        self.assertIsNone(stage.journal().pending)

    def test_synthetic_abort_does_not_adopt_a_creation_without_held_birth(self):
        for path, kind in (('chromium', 'directory'), (EXECUTABLE, 'file')):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory(dir=self.base) as private:
                self.root = Path(private)
                open_file, stat_file = os.open, os.stat

                def open_target(name, flags, mode=0o777, *, dir_fd=None):
                    if kind == 'directory' and name == 'chromium' and dir_fd is not None:
                        raise InterruptedError('fixture directory open interruption')
                    return open_file(name, flags, mode, dir_fd=dir_fd)

                def stat_target(name, *, dir_fd=None, follow_symlinks=True):
                    if kind == 'file' and name == 'chrome-headless-shell' and dir_fd is not None:
                        raise InterruptedError('fixture file readback interruption')
                    return stat_file(name, dir_fd=dir_fd, follow_symlinks=follow_symlinks)

                with self.held() as fd, self.synthetic(fd) as (stage, sources):
                    with patch.object(I.os, 'open', side_effect=open_target), \
                         patch.object(I.os, 'stat', side_effect=stat_target), self.assertRaises(InterruptedError):
                        stage.materialize(*sources)
                self.assertTrue((self.root / path).exists())
                self.assertEqual(stage.journal().pending, (path, kind))
                self.assertNotIn(path, {name for name, *_ in stage.journal().created})

    def test_synthetic_capacity_and_exact_projection_refuse_without_publishing(self):
        for limit, reason in (({'_SYNTHETIC_ENTRIES': 2}, 'tree entry bound'),
                              ({'_SYNTHETIC_BYTES': 0}, 'synthetic tool byte bound'),
                              ({'_SYNTHETIC_SHA': '0' * 64}, 'synthetic tool projection differs')):
            with self.subTest(reason=reason), tempfile.TemporaryDirectory(dir=self.base) as private:
                self.root = Path(private)
                with self.held() as fd, self.synthetic(fd, **limit) as (stage, sources):
                    with self.assertRaisesRegex(T.ArchiveRefused, reason):
                        stage.materialize(*sources)
                self.assertIsNone(stage.journal().pending)
                if reason == 'tree entry bound':
                    self.assertEqual({name for name, *_ in stage.journal().created}, {'chromium', BROWSER})
                if reason == 'synthetic tool byte bound':
                    self.assertEqual(stage.journal().created, ())


if __name__ == '__main__':
    unittest.main()
