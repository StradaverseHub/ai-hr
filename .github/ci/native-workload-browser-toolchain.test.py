"""Synthetic archive models only. No publisher archive, installation or process."""
import base64
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import struct
import sys
import tarfile
import time
import unittest
from unittest.mock import patch
import zlib

spec = importlib.util.spec_from_file_location('strict_browser_toolchain', Path(__file__).with_name('native-workload-browser-toolchain.py'))
T = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = T
spec.loader.exec_module(T)

ROOT = b'chrome-headless-shell-linux64'
ELF = ROOT + b'/chrome-headless-shell'


def deadline():
    return time.monotonic() + 5


def deflate(payload):
    stream = zlib.compressobj(wbits=-15)
    return stream.compress(payload) + stream.flush()


def example_elf(*, machine=62, loader=b'/lib64/ld-linux-x86-64.so.2\0', flags=5):
    raw = bytearray(256)
    raw[:64] = struct.pack('<16sHHIQQQIHHHHHH', b'\x7fELF\x02\x01\x01', 3, machine,
                           1, 0x4000b0, 64, 0, 0, 64, 56, 2, 0, 0, 0)
    raw[64:120] = struct.pack('<IIQQQQQQ', 1, flags, 0, 0x400000, 0x400000, 256, 256, 4096)
    raw[120:176] = struct.pack('<IIQQQQQQ', 3, 4, 192, 0x4000c0, 0x4000c0,
                               len(loader), len(loader), 1)
    raw[192:192 + len(loader)] = loader
    return bytes(raw)


def zipped(entries, *, preamble=b'', gap=b'', locator=b'', count=None):
    local = bytearray(preamble)
    central = bytearray()
    for name, data, opts in entries:
        method = opts.get('method', 8)
        compressed = opts.get('compressed', deflate(data) if method == 8 else data)
        descriptor = opts.get('descriptor')
        flags = opts.get('flags', 8 if descriptor else 0)
        extra = opts.get('extra', b'')
        local_extra = opts.get('local_extra', extra)
        local_name = opts.get('local_name', name)
        clock, date, crc = 15, 16, zlib.crc32(data)
        values = opts.get('values', (crc, len(compressed), len(data)))
        local_values = opts.get('local_values', (0, 0, 0) if descriptor else values)
        position = len(local)
        local += struct.pack('<4s5H3I2H', b'PK\x03\x04', 20, flags, method, clock, date,
                             *local_values, len(local_name), len(local_extra))
        local += local_name + local_extra + compressed
        if descriptor:
            local += b'PK\x07\x08' if descriptor == 'signed' else b''
            local += struct.pack('<III', *opts.get('descriptor_values', values))
        mode = opts.get('mode', stat.S_IFREG | 0o644)
        central += struct.pack('<4s6H3I5H2I', b'PK\x01\x02', 0x314, 20, flags, method, clock,
                               date, *values, len(name), len(extra), 0, 0, 0, mode << 16,
                               opts.get('offset', position))
        central += name + extra
    local += gap
    count = len(entries) if count is None else count
    return bytes(local + central + locator) + struct.pack('<4s4H2IH', b'PK\x05\x06', 0, 0,
           count, count, len(central) + len(locator), len(local), 0)


def zip_rows(raw):
    return T.zip_rows(io.BytesIO(raw), len(raw), deadline())


def tar_entry(path, value=b'', kind=tarfile.REGTYPE, mode=0o644, padding=None):
    info = tarfile.TarInfo(path)
    info.size, info.mode, info.type = len(value), mode, kind
    needed = (-len(value)) % 512
    tail = bytes(needed) if padding is None else padding
    return info.tobuf(format=tarfile.USTAR_FORMAT) + value + tail


def raw_tar(entries, end=bytes(1024)):
    return b''.join(tar_entry(*item) for item in entries) + end


def package_rows(raw):
    return T.package_rows(io.BytesIO(raw), len(raw), deadline())


def sri(raw):
    return 'sha512-' + base64.b64encode(hashlib.sha512(raw).digest()).decode('ascii')


def model_package(name):
    version = {'playwright': '1.62.1', 'playwright-core': '1.62.1', 'postgres': '3.4.9'}[name]
    metadata = {'name': name, 'version': version}
    if name == 'postgres':
        metadata.update(type='module', main='cjs/src/index.js',
                        exports={'import':'./src/index.js', 'default':'./cjs/src/index.js'})
        files = [('package/src/index.js', b'export default function postgres(){}'),
                 ('package/cjs/src/index.js', b'module.exports=function postgres(){}')]
    else:
        metadata['exports'] = {'.': {'import':'./index.mjs', 'require':'./index.js'}}
        files = [('package/index.mjs', b'export const chromium = null'),
                 ('package/index.js', b'exports.chromium = null')]
        if name == 'playwright':
            metadata['dependencies'] = {'playwright-core': '1.62.1'}
            metadata['optionalDependencies'] = {'fsevents': '2.3.2'}
        else:
            browsers = {'browsers':[{'name':'chromium-headless-shell', 'revision':'1234',
                                     'browserVersion':'151.0.7922.34'}]}
            files += [('package/browsers.json', json.dumps(browsers).encode()),
                      ('package/lib/coreBundle.js', b'// synthetic')]
    return version, [('package/package.json', json.dumps(metadata).encode()), *files]


class StrictToolchainArchiveModels(unittest.TestCase):
    def test_complete_zip_checks_actual_bytes_modes_and_both_classic_descriptor_shapes(self):
        data = bytes(range(256)) * 1400
        executable = example_elf()
        raw = zipped([(ELF, executable, {'mode': stat.S_IFREG | 0o755, 'descriptor':'signed'}),
                      (ROOT + b'/locales/en.pak', data, {'descriptor':'unsigned'}),
                      (ROOT + b'/ABOUT', b'about', {'method':0, 'extra':b'\x55\x54\x00\x00'})])
        rows = zip_rows(raw)
        complete = T.with_parents(rows, 10)
        self.assertEqual(len(rows), 3)
        self.assertEqual(len(complete), 5)
        self.assertEqual(rows[ELF.decode()], (ELF.decode(), 'file', 0o555, 256, hashlib.sha256(executable).hexdigest()))
        self.assertEqual(rows[(ROOT + b'/locales/en.pak').decode()][3:], (len(data), hashlib.sha256(data).hexdigest()))

    def test_zip_refuses_bad_local_identity_overlap_preamble_and_descriptor(self):
        name = ROOT + b'/member'
        good = (name, b'content', {})
        for archive in (zipped([(name, b'content', {'local_name':ROOT + b'/Member'})]),
                        zipped([(name, b'content', {'local_values':(0, 0, 0)})]),
                        zipped([(name, b'content', {'descriptor':'signed','descriptor_values':(0, 0, 0)})]),
                        zipped([good], preamble=b'preamble'),
                        zipped([good], gap=b'gap'),
                        zipped([good, (ROOT+b'/peer', b'other', {'offset':0})])):
            with self.subTest(size=len(archive)), self.assertRaises(T.ArchiveRefused):
                zip_rows(archive)

    def test_zip_refuses_hidden_central_members_zip64_extra_and_local_aliases(self):
        name = ROOT + b'/normal'
        for raw in (zipped([(name, b'v', {})], count=2),
                    zipped([(name, b'v', {})], locator=b'PK\x06\x07'+bytes(16)),
                    zipped([(name, b'v', {'extra':b'\x01\x00\x00\x00'})]),
                    zipped([(name, b'v', {'local_extra':b'\x75\x70\x00\x00'})]),
                    zipped([(name, b'v', {'flags':1})]),
                    zipped([(ROOT + b'/../escapes', b'v', {})]),
                    zipped([(name, b'v', {'mode':stat.S_IFLNK | 0o777})]),
                    zipped([(name, b'v', {'mode':stat.S_IFREG | 0o4755})]),
                    zipped([(name, b'v', {}), (name, b'duplicate', {})])):
            with self.subTest(size=len(raw)), self.assertRaises(T.ArchiveRefused):
                zip_rows(raw)

    def test_raw_deflate_requires_natural_exact_end_and_independent_crc(self):
        name = ROOT + b'/member'
        payload = b'payload' * 100
        good = deflate(payload)
        for packed in (good + b'ignored suffix', good + deflate(b'other member'), good[:-1]):
            raw = zipped([(name, payload, {'compressed':packed})])
            with self.subTest(size=len(packed)), self.assertRaises(T.ArchiveRefused):
                zip_rows(raw)
        raw = zipped([(name, payload, {'values':(0, len(good), len(payload))})])
        with self.assertRaisesRegex(T.ArchiveRefused, 'CRC'):
            zip_rows(raw)
        raw = zipped([(name, b'payload', {'compressed':deflate(b'payload'+bytes(20))})])
        with self.assertRaises(T.ArchiveRefused):
            zip_rows(raw)

    def test_executable_program_table_and_tree_parent_are_independent_checks(self):
        for data in (example_elf(machine=183), example_elf(loader=b'/foreign/loader\0'), example_elf(flags=7)):
            with self.subTest(size=len(data)), self.assertRaises(T.ArchiveRefused):
                zip_rows(zipped([(ELF, data, {'mode':stat.S_IFREG | 0o755})]))
        a, b = ROOT+b'/parent', ROOT+b'/parent/child'
        with self.assertRaisesRegex(T.ArchiveRefused, 'collision'):
            T.with_parents(zip_rows(zipped([(a, b'file', {}),(b, b'child', {})])), 10)

    def test_browser_rejects_synthetic_transfer_before_parser_even_at_expected_size(self):
        raw = b'x' * 128
        with patch.object(T, 'BROWSER_ARCHIVE_BYTES', len(raw)), patch.object(T, 'zip_rows') as parser:
            with self.assertRaisesRegex(T.ArchiveRefused, 'pinned browser archive SHA-256'):
                T.inspect_chromium(io.BytesIO(raw), deadline())
        parser.assert_not_called()

    def test_three_fictional_lock_sri_archives_admit_exact_known_package_entrypoints(self):
        for name in ('playwright','playwright-core','postgres'):
            version, members = model_package(name)
            raw = gzip.compress(raw_tar(members), mtime=0)
            with self.subTest(name=name), patch.dict(T.PACKAGES, {name:(version, sri(raw))}):
                actual = T.inspect_package(name, io.BytesIO(raw), deadline())
                expected_files = {path:(len(data), hashlib.sha256(data).hexdigest()) for path,data in members}
                self.assertEqual({row[0]:row[3:] for row in actual if row[1]=='file'}, expected_files)
                self.assertIn(('package','directory',0o555,0,None), actual)

    def test_package_sri_identity_precedes_any_tar_parsing(self):
        raw = gzip.compress(raw_tar(model_package('postgres')[1]), mtime=0)
        with patch.object(T, 'package_rows') as parser:
            with self.assertRaisesRegex(T.ArchiveRefused, 'locked package SHA-512'):
                T.inspect_package('postgres', io.BytesIO(raw), deadline())
            with self.assertRaisesRegex(T.ArchiveRefused, 'unknown tool package'):
                T.inspect_package('other', io.BytesIO(raw), deadline())
        parser.assert_not_called()

    def test_tar_end_cannot_hide_a_gzip_suffix_second_member_or_invalid_footer(self):
        base = gzip.compress(raw_tar([('package/a', b'a')]), mtime=0)
        for raw in (base+b'extra', base+gzip.compress(b'',mtime=0), base[:-1],
                    base[:-8]+b'\0'*8):
            with self.subTest(size=len(raw)), self.assertRaises(T.ArchiveRefused):
                package_rows(raw)

    def test_tar_refuses_extended_entries_links_privilege_duplicates_and_nonzero_padding(self):
        regular = ('package/file',b'x')
        negatives = (
            raw_tar([regular], end=bytes(512)),
            raw_tar([regular], end=bytes(1024)+b'x'+bytes(511)),
            raw_tar([regular, regular]),
            raw_tar([('package/a', b'', tarfile.SYMTYPE)]),
            raw_tar([('package/a', b'', tarfile.XHDTYPE)]),
            raw_tar([('package/a', b'', tarfile.REGTYPE, 0o4755)]),
            raw_tar([('package/file', b'x', tarfile.REGTYPE, 0o644, b'1'+bytes(510))]),
            raw_tar([('package/../file', b'x')]),
            raw_tar([('package/node_modules/foreign/index.js', b'x')]),
        )
        for contents in negatives:
            with self.subTest(size=len(contents)), self.assertRaises(T.ArchiveRefused):
                package_rows(gzip.compress(contents, mtime=0))

    def test_sri_match_alone_cannot_substitute_package_or_browser_manifest(self):
        _, members = model_package('playwright-core')
        for index, changed in ((0, b'{"name":"playwright","version":"1.62.1","exports":{}}'),
                               (3, b'{"browsers":[{"name":"chromium-headless-shell","revision":"other","browserVersion":"151.0.7922.34"}]}')):
            variants = list(members)
            variants[index] = (variants[index][0], changed)
            raw = gzip.compress(raw_tar(variants), mtime=0)
            with self.subTest(index=index), patch.dict(T.PACKAGES, {'playwright-core':('1.62.1',sri(raw))}),                  self.assertRaises(T.ArchiveRefused):
                T.inspect_package('playwright-core', io.BytesIO(raw), deadline())

    def test_combined_tree_budget_accounts_for_implicit_parents_before_each_package(self):
        packages = {}
        for name in ('playwright','playwright-core','postgres'):
            version, members = model_package(name)
            raw = gzip.compress(raw_tar(members), mtime=0)
            packages[name] = (version, raw)
        first, core, postgres = [io.BytesIO(value[1]) for value in packages.values()]
        pins = {name:(version,sri(raw)) for name,(version,raw) in packages.items()}
        with patch.dict(T.PACKAGES,pins), patch.object(T,'PACKAGE_COUNT_MAX',6), \
             patch.object(T,'inspect_chromium',return_value=[]), self.assertRaises(T.ArchiveRefused):
            T.inspect_toolchain(None,first,core,postgres,deadline())
        self.assertEqual(postgres.tell(),0)

    def test_expanded_and_path_limits_refuse_under_a_single_elapsed_deadline(self):
        sample = gzip.compress(raw_tar([('package/large',bytes(1024))]),mtime=0)
        with patch.object(T, 'TAR_MAX', 600), self.assertRaises(T.ArchiveRefused):
            package_rows(sample)
        with self.assertRaisesRegex(T.ArchiveRefused, 'deadline exhausted'):
            T.archive_hash(io.BytesIO(sample), T.PACKAGE_MAX, 'sha512', time.monotonic()-1)
        with self.assertRaises(T.ArchiveRefused):
            T.relative_path(b'package/'+b'a'*250, b'package')


if __name__ == '__main__':
    unittest.main()
